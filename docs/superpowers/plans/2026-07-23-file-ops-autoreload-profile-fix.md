# File Operations, Auto-Reload & Profile-Switch Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VSCode-style file-operations menu (with drag-drop move) and 10s auto-reload to the Explorer, and fix newly-added profiles not appearing / not switching.

**Architecture:** New profile-scoped `POST /api/fs/*` endpoints on the Express server reuse the existing `isSafePath` / `resolveProfile` / `runWith` / `shQuote` helpers and a single pure `fsCommand()` builder. The browser (`public/app.js`) gets a context-menu + inline-input + drag-drop layer over the existing lazy tree, plus a non-destructive polling loop. Pure string/path logic lives in `public/tabstate.js` (UMD) and is unit-tested with `node --test`; DOM wiring is verified live with chrome-devtools.

**Tech Stack:** Node.js, Express, `ws`, node-pty, system `ssh`; vanilla browser JS + xterm.js; `node --test`.

## Global Constraints

- Run/stop the server **only** via `./grv.sh {start|stop|restart|status}` — never `node server.js`, never sudo.
- All remote paths passed to a shell go through `shQuote`; all tree-relative paths are validated with `isSafePath` (rejects absolute, `..`, `.`, NUL) **before** any `spawn`.
- Filesystem endpoints are profile-scoped via `resolveProfile(req.body.profile)`, falling back to the active profile.
- Pure, DOM-free logic goes in `public/tabstate.js` and is unit-tested; DOM code is verified with chrome-devtools.
- Commit after each task. Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Terminal selection/copy is **out of scope** — do not touch tmux mouse settings or xterm selection.
- Git identity is already global `darahask` / `darahask12@gmail.com`.

---

## File Structure

- `server.js` — add `fsCommand(op, {src, dest})` pure builder (exported) + five `POST /api/fs/*` routes via one `fsOpHandler` factory.
- `public/tabstate.js` — add pure helpers: `basename`, `parentDir`, `joinPath`, `isDescendantPath`, `duplicateName`.
- `public/app.js` — profile-fix patch; `startTreePolling()` non-destructive auto-reload; context-menu / inline-input / clipboard / drag-drop layer wired into `renderNodes`.
- `public/style.css` — context-menu + inline-input + drag-over styles; bump `?v=`.
- `public/index.html` — bump `app.js` / `style.css` / `tabstate.js` cache-busting versions.
- `test/fsops.test.js` — `fsCommand` unit tests.
- `test/endpoints.test.js` — extend with `/api/fs/*` 400-before-spawn tests.
- `test/tabstate.test.js` — extend with path-helper tests.

---

## Task 1: Fix profile add/switch (investigate → patch)

**Files:**
- Modify: `public/app.js` (profiles section ~341-486) and/or `public/index.html:174` (cache-bust) — exact change determined by root cause.

**REQUIRED SUB-SKILL:** Use superpowers:systematic-debugging. The client code reads correct on inspection, so do **not** guess-patch — reproduce and root-cause first.

- [ ] **Step 1: Start the server**

Run: `./grv.sh restart && ./grv.sh status`
Expected: `Running (pid …) → http://localhost:4570`

- [ ] **Step 2: Reproduce with chrome-devtools**

Open `http://localhost:4570` maximised. Open the profiles overlay (`#profile-btn`). Click **+ Add profile**, fill `#pf-name`/`#pf-host`/`#pf-remotepath` with a throwaway profile, click **Save** (`#pf-save`). Observe whether the row appears in `#pp-list`. Then click an existing profile row (`.pp-info`) and observe whether it activates. Capture `list_console_messages` and `list_network_requests` during both actions.

Expected: identify the concrete failure (e.g. a thrown error aborting `renderProfileList`, a `404` from `/api/profiles/:name/activate` indicating a stale server, a stale cached `app.js`, or a state desync).

- [ ] **Step 3: Write down the root cause**

State the single root cause in one sentence in the commit body. Do not proceed until you can name it.

- [ ] **Step 4: Apply the minimal fix**

Patch exactly the root cause. Examples by cause:
- Stale cached asset → bump `public/index.html` `app.js?v=` (and add `renderProfileList()` isn't the issue).
- Error thrown mid-handler → wrap the failing call and fix the underlying throw.
- `activateProfile` swallowing a non-OK response → check `res.ok` and `toast` on failure.

Do not add speculative changes beyond the root cause.

- [ ] **Step 5: Verify live**

Re-run Step 2's reproduction. Expected: the new profile row appears immediately in `#pp-list`; clicking a profile row switches active (dot moves, `#sb-profile-name` updates) and triggers `loadTree()` + `loadStatus()` with no console errors.

- [ ] **Step 6: Delete the throwaway profile** via its `✕` button and confirm it disappears.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html
git commit -m "Fix profiles not listing/switching without reload

Root cause: <one sentence>.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Auto-reload tree + git status every 10s (non-destructive)

**Files:**
- Modify: `public/app.js` — add `startTreePolling()`, a non-destructive `refreshTreePreservingState()`, and a `treeInlineEditActive` flag; call `startTreePolling()` once after `loadProfiles()` in the init path (near `public/app.js:213`).

**Interfaces:**
- Produces: `treeInlineEditActive` (boolean, default `false`) — set `true` while an inline create/rename input is open (consumed by Tasks 7-9); `refreshTreePreservingState()` — re-fetches the tree and re-renders while preserving expanded folders, scroll top, and selection.

- [ ] **Step 1: Add the state flag and non-destructive refresh**

In `public/app.js`, near the other explorer module state, add:

```js
let treeInlineEditActive = false;   // true while an inline rename/new-file input is open
let treePollTimer = null;
let treePollInFlight = false;
```

Add a refresh that preserves view state (place next to `loadTree`):

```js
// Re-fetch the tree and re-render without losing the user's place: keep
// expanded folders (expandedDirs is already module state), the tree scroll
// position, and the current selection. Skipped while an inline edit is open.
async function refreshTreePreservingState() {
  if (treeInlineEditActive) return;
  const container = document.getElementById('tree-container');
  const scrollTop = container ? container.scrollTop : 0;
  const selectedPath = document.querySelector('#tree-container .tree-row.selected')?.dataset.path || null;
  try {
    const res = await fetchWithTimeout(`/api/tree${showIgnored ? '?all=1' : ''}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.error) return;
    allFiles = data.files;
    treeData = data.tree;
    renderTree();
    if (selectedPath) {
      const row = treeRowByPath(selectedPath);
      if (row) row.classList.add('selected');
    }
    if (container) container.scrollTop = scrollTop;
  } catch (_) { /* offline / transient — next tick retries */ }
}
```

- [ ] **Step 2: Add the polling loop**

```js
const TREE_POLL_MS = 10000;

// Poll tree + git status so remote changes appear without a manual refresh.
// Pauses when the tab is hidden or offline; coalesces overlapping polls.
function startTreePolling() {
  if (treePollTimer) return;
  treePollTimer = setInterval(async () => {
    if (document.hidden || !navigator.onLine) return;
    if (!profileState.active) return;
    if (treePollInFlight) return;
    treePollInFlight = true;
    try { await Promise.all([refreshTreePreservingState(), loadStatus()]); }
    finally { treePollInFlight = false; }
  }, TREE_POLL_MS);
}
```

- [ ] **Step 3: Start polling in the init path**

After `await loadProfiles();` (near `public/app.js:213`), add:

```js
  startTreePolling();
```

- [ ] **Step 4: Verify live**

Run: `./grv.sh restart`, open the app against a real profile. In a terminal tab on the remote, run `touch AUTORELOAD_TEST.txt` in the repo. Within ~10s the file appears in the tree without a manual refresh. Expand a folder, scroll down, wait a poll cycle — expansion and scroll position are retained. Switch to another browser tab for 30s (hidden) and confirm (via `list_network_requests`) no `/api/tree` polls fire while hidden.

- [ ] **Step 5: Clean up** the test file (`rm AUTORELOAD_TEST.txt` on the remote) and confirm it disappears within ~10s.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "Auto-reload tree + git status every 10s (non-destructive)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Server `fsCommand` builder (pure, TDD)

**Files:**
- Modify: `server.js` — add `fsCommand`, export it.
- Test: `test/fsops.test.js` (create).

**Interfaces:**
- Produces: `fsCommand(op, { src, dest })` → shell-command string. `op` ∈ `{'mkdir','create','delete','rename','copy'}`. `src` always required; `dest` required for `rename`/`copy`. Paths are tree-relative (run under `cd <remotePath>`). Throws `Error` on unknown op. Exported from `server.js`.

- [ ] **Step 1: Write the failing test**

Create `test/fsops.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { fsCommand } = require('../server.js');

test('mkdir builds mkdir -p with a quoted path', () => {
  assert.match(fsCommand('mkdir', { src: 'a/b' }), /^mkdir -p 'a\/b'$/);
});

test('create refuses to clobber then creates an empty file', () => {
  const cmd = fsCommand('create', { src: 'a/x.txt' });
  assert.match(cmd, /\[ -e 'a\/x\.txt' \]/);
  assert.match(cmd, /: > 'a\/x\.txt'/);
});

test('delete builds rm -rf with a quoted path', () => {
  assert.match(fsCommand('delete', { src: 'a/b' }), /^rm -rf 'a\/b'$/);
});

test('rename guards the destination then moves', () => {
  const cmd = fsCommand('rename', { src: 'a', dest: 'b/a' });
  assert.match(cmd, /\[ -e 'b\/a' \]/);
  assert.match(cmd, /mv 'a' 'b\/a'/);
});

test('copy guards the destination then cp -r', () => {
  const cmd = fsCommand('copy', { src: 'a', dest: 'b/a' });
  assert.match(cmd, /\[ -e 'b\/a' \]/);
  assert.match(cmd, /cp -r 'a' 'b\/a'/);
});

test('single quotes in a path are escaped, not injectable', () => {
  assert.match(fsCommand('delete', { src: "a'b" }), /'a'\\''b'/);
});

test('unknown op throws', () => {
  assert.throws(() => fsCommand('chmod', { src: 'a' }), /Unknown fs op/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/fsops.test.js`
Expected: FAIL — `fsCommand is not a function`.

- [ ] **Step 3: Implement `fsCommand`**

In `server.js`, next to `shQuote`/`isSafePath` (~line 167), add:

```js
// Build a shell command for a filesystem operation on tree-relative, already
// isSafePath-validated paths. Runs under `cd <remotePath>` (see runWith), so
// relative paths resolve inside the repo. rename/copy refuse to clobber an
// existing destination. Throws on an unknown op.
function fsCommand(op, { src, dest } = {}) {
  const s = shQuote(src);
  const d = dest != null ? shQuote(dest) : null;
  switch (op) {
    case 'mkdir':  return `mkdir -p ${s}`;
    case 'create': return `if [ -e ${s} ]; then echo 'File already exists' >&2; exit 1; fi; : > ${s}`;
    case 'delete': return `rm -rf ${s}`;
    case 'rename': return `if [ -e ${d} ]; then echo 'Target already exists' >&2; exit 1; fi; mv ${s} ${d}`;
    case 'copy':   return `if [ -e ${d} ]; then echo 'Target already exists' >&2; exit 1; fi; cp -r ${s} ${d}`;
    default: throw new Error(`Unknown fs op: ${op}`);
  }
}
```

Add `fsCommand` to `module.exports` (~line 642):

```js
module.exports = {
  app,
  shQuote,
  sanitizeSessionId,
  tmuxSessionName,
  remoteTerminalCommand,
  remoteFallbackCommand,
  fsCommand,
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test test/fsops.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server.js test/fsops.test.js
git commit -m "Add fsCommand builder for filesystem operations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Server `/api/fs/*` endpoints (TDD)

**Files:**
- Modify: `server.js` — add `fsOpHandler` factory + five routes, placed after the profiles routes (~line 283).
- Test: `test/endpoints.test.js` (extend).

**Interfaces:**
- Consumes: `fsCommand` (Task 3), `isSafePath`, `resolveProfile`, `runWith`.
- Produces: `POST /api/fs/mkdir` `{src[,profile]}`, `POST /api/fs/create` `{src[,profile]}`, `POST /api/fs/delete` `{src[,profile]}`, `POST /api/fs/rename` `{src,dest[,profile]}`, `POST /api/fs/copy` `{src,dest[,profile]}`. All return `{ok:true}` or `{error}`; `400` on invalid path/dest before any spawn.

- [ ] **Step 1: Write the failing tests**

Append to `test/endpoints.test.js`:

```js
test('POST /api/fs/delete rejects a path escape with 400 (before any ssh)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/fs/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: '../secret' }),
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /invalid path/i);
  });
});

test('POST /api/fs/rename rejects a bad destination with 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/fs/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: 'a.txt', dest: '/etc/passwd' }),
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /destination/i);
  });
});

test('POST /api/fs/mkdir rejects a missing path with 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/fs/mkdir`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test test/endpoints.test.js`
Expected: FAIL — routes return 404, not 400.

- [ ] **Step 3: Implement the handler + routes**

In `server.js`, after the `/api/profiles/:name/activate` route (~line 283), add:

```js
// Filesystem operations on tree-relative paths. Path validation runs before
// any spawn, so malformed input can never reach a shell.
function fsOpHandler(op, needsDest) {
  return async (req, res) => {
    const { src, dest } = req.body || {};
    if (!isSafePath(src)) return res.status(400).json({ error: 'Invalid path' });
    if (needsDest && !isSafePath(dest)) return res.status(400).json({ error: 'Invalid destination' });
    const profile = resolveProfile(req.body && req.body.profile);
    if (!profile || !profile.remotePath) return res.status(400).json({ error: 'No active profile.' });
    try {
      const result = await runWith(profile, fsCommand(op, { src, dest }));
      if (result.code !== 0) return res.status(500).json({ error: (result.stderr || '').trim() || 'Operation failed' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  };
}

app.post('/api/fs/mkdir',  fsOpHandler('mkdir', false));
app.post('/api/fs/create', fsOpHandler('create', false));
app.post('/api/fs/delete', fsOpHandler('delete', false));
app.post('/api/fs/rename', fsOpHandler('rename', true));
app.post('/api/fs/copy',   fsOpHandler('copy', true));
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/endpoints.test.js`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Full suite**

Run: `node --test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add server.js test/endpoints.test.js
git commit -m "Add /api/fs/* endpoints for create/rename/move/copy/delete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Client pure path helpers (TDD)

**Files:**
- Modify: `public/tabstate.js` — add `basename`, `parentDir`, `joinPath`, `isDescendantPath`, `duplicateName` to the factory return.
- Test: `test/tabstate.test.js` (extend).

**Interfaces:**
- Produces (on `TabState`): `basename(p)`, `parentDir(p)`, `joinPath(dir,name)`, `isDescendantPath(ancestor,p)`, `duplicateName(name, existingNames[])`. Consumed by Tasks 8-9.

- [ ] **Step 1: Write the failing tests**

Append to `test/tabstate.test.js`:

```js
test('basename returns the last path segment', () => {
  assert.strictEqual(TabState.basename('a/b/c.txt'), 'c.txt');
  assert.strictEqual(TabState.basename('c.txt'), 'c.txt');
  assert.strictEqual(TabState.basename('a/b/'), 'b');
});

test('parentDir returns the directory, empty at root', () => {
  assert.strictEqual(TabState.parentDir('a/b/c.txt'), 'a/b');
  assert.strictEqual(TabState.parentDir('c.txt'), '');
});

test('joinPath joins, treating empty dir as root', () => {
  assert.strictEqual(TabState.joinPath('a/b', 'c.txt'), 'a/b/c.txt');
  assert.strictEqual(TabState.joinPath('', 'c.txt'), 'c.txt');
});

test('isDescendantPath: root contains all; node contains self and children', () => {
  assert.strictEqual(TabState.isDescendantPath('', 'a/b'), true);
  assert.strictEqual(TabState.isDescendantPath('a', 'a'), true);
  assert.strictEqual(TabState.isDescendantPath('a', 'a/b'), true);
  assert.strictEqual(TabState.isDescendantPath('a', 'ab'), false);
  assert.strictEqual(TabState.isDescendantPath('a/b', 'a'), false);
});

test('duplicateName inserts " copy" before the extension and dedupes', () => {
  assert.strictEqual(TabState.duplicateName('f.txt', []), 'f copy.txt');
  assert.strictEqual(TabState.duplicateName('f.txt', ['f copy.txt']), 'f copy 2.txt');
  assert.strictEqual(TabState.duplicateName('dir', ['dir copy']), 'dir copy 2');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test test/tabstate.test.js`
Expected: FAIL — `TabState.basename is not a function`.

- [ ] **Step 3: Implement the helpers**

In `public/tabstate.js`, inside the factory before `return {...}`, add:

```js
  function basename(p) {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
  }
  function parentDir(p) {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i === -1 ? '' : s.slice(0, i);
  }
  function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : String(name);
  }
  function isDescendantPath(ancestor, p) {
    if (!ancestor) return true;              // root contains everything
    return p === ancestor || p.startsWith(ancestor + '/');
  }
  function duplicateName(name, existingNames) {
    const set = new Set(existingNames || []);
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext  = hasExt ? name.slice(dot) : '';
    let candidate = `${stem} copy${ext}`, n = 2;
    while (set.has(candidate)) { candidate = `${stem} copy ${n}${ext}`; n++; }
    return candidate;
  }
```

Update the return:

```js
  return { nextBackoffDelay, serializeTabs, reconcileTerminalTabs,
           basename, parentDir, joinPath, isDescendantPath, duplicateName };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/tabstate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/tabstate.js test/tabstate.test.js
git commit -m "Add pure path helpers for file-tree operations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Context menu skeleton + non-mutating ops + CSS

**Files:**
- Modify: `public/app.js` — add `fsRequest()` helper, a context-menu builder `showTreeContextMenu(e, path, isDir)`, wire `contextmenu` listeners in `renderNodes` (dir + file rows) and on `#tree-container` empty space. Implement the actions that need no new inline UI: **Delete**, **Copy Path**, **Copy Relative Path**, **Download**, **Reveal**.
- Modify: `public/style.css` — context-menu styles; bump `?v=`.
- Modify: `public/index.html` — bump `app.js`, `style.css`, `tabstate.js` versions.

**Interfaces:**
- Consumes: `fsCommand` endpoints (Task 4) via `fsRequest`; `revealInTree`, `downloadDir`, existing `/api/download`.
- Produces: `fsRequest(op, body)` → `Promise<{ok}|{error}>`; `showTreeContextMenu(event, path, isDir)`; a single reusable menu element `#tree-context-menu`. Consumed by Tasks 7-9.

- [ ] **Step 1: Add the endpoint helper**

In `public/app.js` near the other fetch helpers, add:

```js
// POST a filesystem op to the server, scoped to the active profile.
async function fsRequest(op, body) {
  try {
    const res = await fetchWithTimeout(`/api/fs/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, profile: profileState.active || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) { toast(data.error || `Could not ${op}`); return { error: data.error || true }; }
    return { ok: true };
  } catch (err) { toast(err.message); return { error: err.message }; }
}
```

- [ ] **Step 2: Add a dismissable menu primitive**

```js
// A single reusable context menu. items: [{label, action, danger}] or {separator:true}.
function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.id = 'tree-context-menu';
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    row.textContent = it.label;
    if (!it.disabled) row.addEventListener('click', () => { hideContextMenu(); it.action(); });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // clamp to viewport
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 4) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
}
function hideContextMenu() {
  document.getElementById('tree-context-menu')?.remove();
}
document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', hideContextMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
```

- [ ] **Step 3: Build the tree menu (this task's actions only; create/rename/clipboard added in Tasks 7-8)**

```js
function absoluteRemotePath(rel) {
  const base = (statusRemotePath || '').replace(/\/+$/, '');   // set by loadStatus()
  return base ? `${base}/${rel}` : rel;
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (_) { toast('Copy failed'); }
}

function showTreeContextMenu(e, path, isDir) {
  e.preventDefault();
  e.stopPropagation();
  const items = [
    // create/rename/clipboard items are inserted by Tasks 7-8
    { label: 'Copy Path', action: () => copyToClipboard(absoluteRemotePath(path)) },
    { label: 'Copy Relative Path', action: () => copyToClipboard(path) },
    { separator: true },
    { label: 'Download', action: () => isDir ? downloadDir(path) : downloadFile(path) },
    { label: 'Reveal in Explorer', action: () => revealInTree(path) },
    { separator: true },
    { label: 'Delete', danger: true, action: () => deleteEntry(path, isDir) },
  ];
  showContextMenu(e.clientX, e.clientY, items);
}

function downloadFile(path) {
  const a = document.createElement('a');
  a.href = `/api/download?path=${encodeURIComponent(path)}`;
  a.download = TabState.basename(path);
  document.body.appendChild(a); a.click(); a.remove();
}

async function deleteEntry(path, isDir) {
  if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${TabState.basename(path)}"?${isDir ? '\nThis removes all its contents.' : ''}`)) return;
  const r = await fsRequest('delete', { src: path });
  if (r.ok) { toast('Deleted'); await refreshTreePreservingState(); loadStatus(); }
}
```

Add a module-level `let statusRemotePath = '';` and set it in `loadStatus()` where the response is handled (`statusRemotePath = data.remotePath || statusRemotePath;`).

- [ ] **Step 4: Wire `contextmenu` on rows**

In `renderNodes`, for the **dir** `row` add before `frag.appendChild(row)`:

```js
      row.addEventListener('contextmenu', e => showTreeContextMenu(e, fullPath, true));
```

For the **file** row (find where the file `row` is built in `renderNodes`) add:

```js
      row.addEventListener('contextmenu', e => showTreeContextMenu(e, fullPath, false));
```

On the container empty area, in `renderTree()` after building, ensure `#tree-container` has:

```js
  container.addEventListener('contextmenu', e => {
    if (e.target.closest('.tree-row')) return;      // row menus handle their own
    showTreeContextMenu(e, '', true);               // '' = repo root
  }, { once: false });
```

(Guard against double-binding: add the listener once in `init`, not inside `renderTree`, keying off `container`.)

- [ ] **Step 5: CSS**

Append to `public/style.css`:

```css
.ctx-menu { position: fixed; z-index: 9999; min-width: 190px; padding: 4px;
  background: var(--panel, #252526); border: 1px solid rgba(255,255,255,.12);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.4); font-size: 13px; }
.ctx-item { padding: 5px 12px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.ctx-item:hover { background: var(--accent, #094771); }
.ctx-item.danger { color: #f48771; }
.ctx-item.disabled { opacity: .4; pointer-events: none; }
.ctx-sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.1); }
```

- [ ] **Step 6: Bump cache versions** in `public/index.html`: `style.css?v=6`, `tabstate.js?v=2`, `app.js?v=35`.

- [ ] **Step 7: Verify live**

Run: `./grv.sh restart`, hard-reload. Right-click a file → menu shows. **Copy Path** / **Copy Relative Path** copy the right strings (paste into the terminal to check). **Download** downloads. **Reveal** selects+scrolls. **Delete** on a throwaway file removes it and the tree updates. Right-click empty space → menu appears rooted at repo root. Menu dismisses on outside-click / Escape / scroll.

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/style.css public/index.html
git commit -m "File-tree context menu: delete, copy path, download, reveal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Inline New File / New Folder / Rename

**Files:**
- Modify: `public/app.js` — add `beginInlineInput(...)`, `newFile`, `newFolder`, `renameEntry`; insert their items into `showTreeContextMenu`.

**Interfaces:**
- Consumes: `fsRequest` (Task 6), `treeInlineEditActive` (Task 2), `TabState.parentDir/joinPath` (Task 5).
- Produces: `newFile(dirPath)`, `newFolder(dirPath)`, `renameEntry(path, isDir)`.

- [ ] **Step 1: Inline input primitive**

```js
// Show a temporary text input in the tree to capture a name. onCommit(value)
// runs on Enter (non-empty); Escape/blur cancels. Suppresses tree polling
// while open so a refresh can't destroy the input.
function beginInlineInput({ initial = '', placeholder = '', onCommit }) {
  treeInlineEditActive = true;
  const overlay = document.createElement('div');
  overlay.className = 'tree-inline-input';
  const input = document.createElement('input');
  input.type = 'text'; input.value = initial; input.placeholder = placeholder;
  overlay.appendChild(input);
  document.getElementById('tree-container').prepend(overlay);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    treeInlineEditActive = false;
    const val = input.value.trim();
    overlay.remove();
    if (commit && val) onCommit(val);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
}
```

- [ ] **Step 2: The three actions**

```js
function newFile(dirPath) {
  beginInlineInput({ placeholder: 'New file name…', onCommit: async name => {
    const dest = TabState.joinPath(dirPath, name);
    const r = await fsRequest('create', { src: dest });
    if (r.ok) { const parts = dest.split('/'); parts.pop(); if (parts.length) expandedDirs.add(parts.join('/')); await refreshTreePreservingState(); revealInTree(dest); }
  }});
}
function newFolder(dirPath) {
  beginInlineInput({ placeholder: 'New folder name…', onCommit: async name => {
    const dest = TabState.joinPath(dirPath, name);
    const r = await fsRequest('mkdir', { src: dest });
    if (r.ok) { expandedDirs.add(dest); await refreshTreePreservingState(); revealInTree(dest); }
  }});
}
function renameEntry(path, isDir) {
  beginInlineInput({ initial: TabState.basename(path), onCommit: async name => {
    const dest = TabState.joinPath(TabState.parentDir(path), name);
    if (dest === path) return;
    const r = await fsRequest('rename', { src: path, dest });
    if (r.ok) { await refreshTreePreservingState(); revealInTree(dest); loadStatus(); }
  }});
}
```

- [ ] **Step 3: Add menu items** in `showTreeContextMenu`, at the top of `items`:

```js
    ...(isDir ? [
      { label: 'New File', action: () => newFile(path) },
      { label: 'New Folder', action: () => newFolder(path) },
      { separator: true },
    ] : []),
    { label: 'Rename', action: () => renameEntry(path, isDir), disabled: !path },
```

(For the empty-root menu `path===''` and `isDir===true`, so New File/New Folder appear; Rename is disabled at root.)

- [ ] **Step 4: CSS** — append to `public/style.css`:

```css
.tree-inline-input { padding: 2px 6px; }
.tree-inline-input input { width: 100%; box-sizing: border-box; font: inherit;
  padding: 2px 6px; background: var(--input-bg, #1e1e1e); color: inherit;
  border: 1px solid var(--accent, #094771); border-radius: 3px; outline: none; }
```

- [ ] **Step 5: Verify live**

Right-click a folder → **New File**, type `hello.txt`, Enter → file created, revealed, opens on click. **New Folder** → creates and expands. **Rename** a throwaway file → renamed, git status updates. Creating a file that already exists shows the "File already exists" toast. Escape cancels an inline input with no side effect.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/style.css
git commit -m "Inline new file / new folder / rename in the file tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Cut / Copy / Paste / Duplicate

**Files:**
- Modify: `public/app.js` — add a `treeClipboard` state, `cutEntry`/`copyEntry`/`pasteInto`/`duplicateEntry`; insert menu items.

**Interfaces:**
- Consumes: `fsRequest`, `TabState.basename/joinPath/isDescendantPath/duplicateName`, `refreshTreePreservingState`.
- Produces: `treeClipboard` (`{mode:'cut'|'copy', path} | null`), `cutEntry`, `copyEntry`, `pasteInto(dirPath)`, `duplicateEntry`.

- [ ] **Step 1: Clipboard state + actions**

```js
let treeClipboard = null;   // { mode: 'cut' | 'copy', path }

function cutEntry(path)  { treeClipboard = { mode: 'cut',  path }; toast('Cut'); }
function copyEntry(path) { treeClipboard = { mode: 'copy', path }; toast('Copied'); }

// Move or copy the clipboard entry into dirPath (''=root).
async function pasteInto(dirPath) {
  if (!treeClipboard) return;
  const { mode, path } = treeClipboard;
  const dest = TabState.joinPath(dirPath, TabState.basename(path));
  if (dest === path) { toast('Already there'); return; }
  if (mode === 'cut' && TabState.isDescendantPath(path, dirPath)) { toast("Can't move a folder into itself"); return; }
  const r = await fsRequest(mode === 'cut' ? 'rename' : 'copy', { src: path, dest });
  if (r.ok) {
    if (mode === 'cut') treeClipboard = null;
    if (dirPath) expandedDirs.add(dirPath);
    await refreshTreePreservingState(); revealInTree(dest); loadStatus();
  }
}

// Copy an entry next to itself with a " copy" suffix.
async function duplicateEntry(path) {
  const dir = TabState.parentDir(path);
  const siblings = allFiles
    .filter(f => TabState.parentDir(f) === dir)
    .map(f => TabState.basename(f));
  const dest = TabState.joinPath(dir, TabState.duplicateName(TabState.basename(path), siblings));
  const r = await fsRequest('copy', { src: path, dest });
  if (r.ok) { await refreshTreePreservingState(); revealInTree(dest); }
}
```

- [ ] **Step 2: Add menu items** in `showTreeContextMenu`. After the Rename item add:

```js
    { label: 'Cut', action: () => cutEntry(path), disabled: !path },
    { label: 'Copy', action: () => copyEntry(path), disabled: !path },
    { label: 'Paste', action: () => pasteInto(isDir ? path : TabState.parentDir(path)), disabled: !treeClipboard },
    { label: 'Duplicate', action: () => duplicateEntry(path), disabled: !path },
```

(Paste target: into the folder when a dir is right-clicked, else into the file's parent. At empty root, `path===''` → paste into root.)

- [ ] **Step 3: Verify live**

**Cut** a file, **Paste** into another folder → moved (git status reflects it). **Copy** a file, **Paste** → copied. **Duplicate** a file `f.txt` → `f copy.txt`; duplicate again → `f copy 2.txt`. Cutting a folder and pasting into itself/descendant shows the guard toast and does nothing.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Cut/copy/paste/duplicate in the file tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Drag-and-drop move

**Files:**
- Modify: `public/app.js` — make tree rows draggable, add dragover/drop handlers on folder rows and the container root.
- Modify: `public/style.css` — `.drag-over` highlight.

**Interfaces:**
- Consumes: `fsRequest`, `TabState.basename/joinPath/isDescendantPath/parentDir`, `refreshTreePreservingState`.

- [ ] **Step 1: Make rows draggable + carry their path**

In `renderNodes`, for **both** the dir `row` and file `row`, after setting `row.dataset.path`, add:

```js
      row.draggable = true;
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/grv-path', fullPath);
        e.dataTransfer.effectAllowed = 'move';
      });
```

- [ ] **Step 2: Drop targets on folder rows**

For the **dir** `row` add:

```js
      row.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('text/grv-path')) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation(); row.classList.remove('drag-over');
        await moveByDrag(e.dataTransfer.getData('text/grv-path'), fullPath);
      });
```

- [ ] **Step 3: Drop on empty container = move to root**

Add once (in `init`, keyed off `#tree-container`):

```js
  const tc = document.getElementById('tree-container');
  tc.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/grv-path')) e.preventDefault(); });
  tc.addEventListener('drop', async e => {
    if (e.target.closest('.tree-row')) return;    // folder rows handle their own
    e.preventDefault();
    await moveByDrag(e.dataTransfer.getData('text/grv-path'), '');
  });
```

- [ ] **Step 4: The move**

```js
async function moveByDrag(src, targetDir) {
  if (!src) return;
  if (TabState.parentDir(src) === targetDir) return;               // already there
  if (TabState.isDescendantPath(src, targetDir)) { toast("Can't move a folder into itself"); return; }
  const dest = TabState.joinPath(targetDir, TabState.basename(src));
  const r = await fsRequest('rename', { src, dest });
  if (r.ok) { if (targetDir) expandedDirs.add(targetDir); await refreshTreePreservingState(); revealInTree(dest); loadStatus(); }
}
```

- [ ] **Step 5: CSS** — append to `public/style.css`:

```css
.tree-row.drag-over { background: var(--accent, #094771); outline: 1px solid #3794ff; }
```

- [ ] **Step 6: Verify live**

Drag a file onto a folder → moves in (git status reflects it). Drag a folder into another folder → moves. Drag a folder onto itself/a descendant → guard toast, no change. Drag a file to empty space → moves to repo root.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/style.css
git commit -m "Drag-and-drop move in the file tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `node --test` → all green.
- [ ] `./grv.sh restart`, hard-reload, smoke-test: profile add/switch, auto-reload, and every context-menu op + drag-drop against the real remote.
- [ ] Update `public/index.html` cache versions if any later task changed `app.js`/`style.css` again (ensure final `app.js?v=` is past `34`).

## Self-Review notes (author)

- **Spec coverage:** profile fix → Task 1; auto-reload → Task 2; server ops → Tasks 3-4; full menu set (New File/Folder, Rename, Delete, Cut/Copy/Paste, Duplicate, Copy Path, Copy Relative Path, Download, Reveal) → Tasks 6-8; drag-drop move → Task 9; path-safety tests → Tasks 3-5.
- **Move = rename:** move (drag + paste-cut) reuses `/api/fs/rename`, matching the spec's "Rename and Move — one op."
- **Type consistency:** `fsRequest(op, body)`, `TabState.{basename,parentDir,joinPath,isDescendantPath,duplicateName}`, `refreshTreePreservingState`, `treeInlineEditActive`, `treeClipboard`, `statusRemotePath` used consistently across tasks.
