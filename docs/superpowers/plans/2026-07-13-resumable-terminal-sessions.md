# Resumable Terminal Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote terminal (Claude Code) sessions survive VPN/network changes, browser reloads, and node restarts by running each shell inside a persistent tmux session on the remote, with client-side auto-reconnect and tab restoration.

**Architecture:** The node server runs on the user's laptop; only SSH reaches the remote. Today each terminal is a one-shot `ssh → $SHELL` whose shell dies with the SSH connection. This plan wraps the remote shell in a named tmux session (`grv_<sessionId>`) that outlives the SSH transport. Each browser terminal tab owns a stable `sessionId`; on any disconnect the client auto-reconnects and the server re-runs `tmux new-session -A` (attach-or-create), so Claude Code is picked up exactly where it was. If the remote has no tmux, the code falls back to today's non-persistent behavior.

**Tech Stack:** Node.js (v18+, dev machine has v24), `ws` (WebSocketServer), `node-pty`, `express`, xterm.js in the browser, `tmux` on the remote, `node --test` for unit tests (zero new dependencies).

## Global Constraints

- **No new runtime npm dependencies.** Tests use the built-in `node --test` runner only.
- **Node floor:** v18+ (`node --test` and `crypto.randomUUID` both required).
- **tmux is optional on the remote.** Detect it; when absent, fall back to the current one-shot `exec $SHELL -l` behavior. Never hard-fail because tmux is missing.
- **Shell-injection safety:** any value interpolated into a remote shell command must be quoted (`shQuote`) or validated against `^[A-Za-z0-9_]+$`. Session ids are validated; paths use `shQuote`.
- **tmux session naming:** `grv_<sanitizedSessionId>` where the sanitized id matches `^[A-Za-z0-9_]+$` (tmux forbids `.` and `:` in names).
- **Terminals bind to the profile they were created under** (passed explicitly as a query param), never `getActive()` at reconnect time.
- **Preserve existing patterns:** single `server.js` on the backend, single `public/app.js` on the frontend loaded as a plain (non-module) script. Do not introduce a bundler/build step.

---

## File Structure

- `server.js` (modify) — extract pure terminal-command helpers + exports; add tmux probe; rewire the WebSocket handler; add two terminal-session endpoints; guard `server.listen` behind `require.main === module` so the module can be required in tests.
- `public/tabstate.js` (create) — pure, DOM-free helpers for reconnect backoff, tab serialization, and terminal-session reconciliation. Uses a UMD guard so it loads as a browser `<script>` **and** is `require()`-able by node tests.
- `public/app.js` (modify) — `sessionId` per terminal tab; `connectTerminal()` with auto-reconnect; online/focus fast-reconnect; connection indicator; `fetchWithTimeout`; localStorage tab persistence + restore; explicit-close kills the remote session.
- `public/index.html` (modify) — load `tabstate.js` before `app.js`; add a connection-status element to the status bar.
- `test/terminal.test.js` (create) — unit tests for the server pure helpers.
- `test/tabstate.test.js` (create) — unit tests for the client pure helpers.
- `package.json` (modify) — add `"test": "node --test"`.
- `docs/RECONNECT-TESTING.md` (create) — the manual disruption runbook.

---

## Task 1: Server pure terminal helpers + unit tests

Extract the pure, testable pieces (session-id validation, tmux session naming, remote-command construction) as named functions, export them, and guard the server from auto-listening when required by a test.

**Files:**
- Modify: `server.js` (add helpers near the terminal section ~line 436; add `require.main` guard + exports at the bottom ~line 482)
- Create: `test/terminal.test.js`
- Modify: `package.json` (add test script)

**Interfaces:**
- Produces:
  - `sanitizeSessionId(raw: string): string | null` — returns the id if it matches `^[A-Za-z0-9_]+$` and is ≤ 64 chars, else `null`.
  - `tmuxSessionName(sessionId: string): string` — returns `'grv_' + sessionId` (caller passes an already-sanitized id).
  - `remoteTerminalCommand({ repoPath, sessionName }): string` — the tmux attach-or-create command string.
  - `remoteFallbackCommand({ repoPath }): string` — today's one-shot login-shell command string.
  - `module.exports` exposing all four (plus `shQuote`, already defined).

- [ ] **Step 1: Write the failing test**

Create `test/terminal.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../server.js');

test('sanitizeSessionId accepts valid ids', () => {
  assert.strictEqual(t.sanitizeSessionId('abc123_DEF'), 'abc123_DEF');
});

test('sanitizeSessionId rejects shell metacharacters', () => {
  assert.strictEqual(t.sanitizeSessionId('a; rm -rf /'), null);
  assert.strictEqual(t.sanitizeSessionId('a.b'), null);
  assert.strictEqual(t.sanitizeSessionId('a:b'), null);
  assert.strictEqual(t.sanitizeSessionId(''), null);
  assert.strictEqual(t.sanitizeSessionId('$(x)'), null);
});

test('sanitizeSessionId rejects overly long ids', () => {
  assert.strictEqual(t.sanitizeSessionId('a'.repeat(65)), null);
});

test('tmuxSessionName prefixes with grv_', () => {
  assert.strictEqual(t.tmuxSessionName('deadbeef'), 'grv_deadbeef');
});

test('remoteTerminalCommand builds an attach-or-create tmux command', () => {
  const cmd = t.remoteTerminalCommand({ repoPath: '/home/me/repo', sessionName: 'grv_x' });
  assert.match(cmd, /cd '\/home\/me\/repo' 2>\/dev\/null; /);
  assert.match(cmd, /exec tmux new-session -A -s grv_x \$SHELL -l/);
});

test('remoteTerminalCommand quotes paths with spaces/quotes safely', () => {
  const cmd = t.remoteTerminalCommand({ repoPath: "/tmp/a b'c", sessionName: 'grv_x' });
  assert.ok(cmd.includes(`cd '/tmp/a b'\\''c'`));
});

test('remoteFallbackCommand is a plain login shell', () => {
  const cmd = t.remoteFallbackCommand({ repoPath: '/home/me/repo' });
  assert.match(cmd, /cd '\/home\/me\/repo' 2>\/dev\/null; exec \$SHELL -l/);
  assert.ok(!cmd.includes('tmux'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/terminal.test.js`
Expected: FAIL — `t.sanitizeSessionId is not a function` (helpers not exported yet).

- [ ] **Step 3: Add the helpers to `server.js`**

Insert immediately above the `// Terminal (PTY-backed SSH over WebSocket)` banner (currently ~line 436). Reuse the existing `shQuote` (defined at line 135):

```js
// ---------------------------------------------------------------------------
// Terminal session helpers (pure — unit-tested in test/terminal.test.js)
// ---------------------------------------------------------------------------

// Session ids come from the browser and are interpolated into a tmux session
// name inside a remote shell command, so they must be strictly validated.
function sanitizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 64) return null;
  return /^[A-Za-z0-9_]+$/.test(raw) ? raw : null;
}

function tmuxSessionName(sessionId) {
  return 'grv_' + sessionId;
}

// Attach-or-create: `-A` reattaches if the session exists, else creates it and
// runs a login shell in the repo dir. On reattach the trailing command is
// ignored, so scrollback / running processes (Claude Code) are preserved.
function remoteTerminalCommand({ repoPath, sessionName }) {
  const cd = repoPath ? `cd ${shQuote(repoPath)} 2>/dev/null; ` : '';
  return `${cd}exec tmux new-session -A -s ${sessionName} $SHELL -l`;
}

function remoteFallbackCommand({ repoPath }) {
  const cd = repoPath ? `cd ${shQuote(repoPath)} 2>/dev/null; ` : '';
  return `${cd}exec $SHELL -l`;
}
```

- [ ] **Step 4: Guard `server.listen` and export helpers**

Replace the current bottom of `server.js` (lines 482-486):

```js
const PORT = process.env.PORT || 4570;
server.listen(PORT, () => {
  console.log(`Git Remote Viewer → http://localhost:${PORT}`);
  if (!activeProfileName) console.log('No profiles yet — open the UI to create one.');
});
```

with:

```js
const PORT = process.env.PORT || 4570;

// Only start listening when run directly (`node server.js`). When required by a
// unit test, export the pure helpers instead of booting a server.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Git Remote Viewer → http://localhost:${PORT}`);
    if (!activeProfileName) console.log('No profiles yet — open the UI to create one.');
  });
}

module.exports = {
  shQuote,
  sanitizeSessionId,
  tmuxSessionName,
  remoteTerminalCommand,
  remoteFallbackCommand,
};
```

- [ ] **Step 5: Add the test script to `package.json`**

Change the `"scripts"` block from:

```json
  "scripts": {
    "start": "node server.js"
  },
```

to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/terminal.test.js`
Expected: PASS — all 7 tests green. (Requiring `server.js` must NOT print the "Git Remote Viewer" banner, proving the `require.main` guard works.)

- [ ] **Step 7: Commit**

```bash
git add server.js test/terminal.test.js package.json
git commit -m "Add pure terminal-session helpers with unit tests"
```

---

## Task 2: Server tmux detection + WebSocket handler rewiring

Probe the remote for tmux (cached per profile), and rebuild the WebSocket handler to read `session`/`profile` from the query, bind to the named profile, and choose the tmux or fallback command.

**Files:**
- Modify: `server.js` — split `sshTerminalArgs` into a base-args function; add `probeTmux`; rewrite `wss.on('connection', ...)` (currently lines 443-480) and `sshTerminalArgs` (lines 59-72).

**Interfaces:**
- Consumes: `sanitizeSessionId`, `tmuxSessionName`, `remoteTerminalCommand`, `remoteFallbackCommand` (Task 1); existing `sshArgs`, `getActive`, `profiles`, `ctlPath`.
- Produces:
  - `sshBaseTerminalArgs(profile): string[]` — the `ssh -tt` invocation args WITHOUT the trailing remote command.
  - `probeTmux(profile): Promise<boolean>` — true if `tmux` is on the remote PATH; result cached per `user@host`.
  - WebSocket URL contract: `/terminal?session=<id>&profile=<name>&cols=<n>&rows=<n>`.

- [ ] **Step 1: Replace `sshTerminalArgs` with a base-args builder**

Replace `sshTerminalArgs` (lines 59-72) with:

```js
// Base args for an interactive login shell over SSH (no trailing command — the
// caller appends the remote command it wants to run).
function sshBaseTerminalArgs(profile) {
  const args = [
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${ctlPath(profile)}`,
    '-o', 'ControlPersist=120',
  ];
  if (profile.port && Number(profile.port) !== 22) args.push('-p', String(profile.port));
  args.push(profile.username ? `${profile.username}@${profile.host}` : profile.host);
  return args;
}
```

- [ ] **Step 2: Add the tmux probe with per-profile caching**

Insert just below `sshBaseTerminalArgs`:

```js
// Cache tmux availability per user@host so we probe the remote only once.
const _tmuxCache = new Map();

function profileKey(profile) {
  return (profile.username ? profile.username + '@' : '') + profile.host;
}

function probeTmux(profile) {
  const key = profileKey(profile);
  if (_tmuxCache.has(key)) return Promise.resolve(_tmuxCache.get(key));
  return new Promise((resolve) => {
    const proc = spawn('ssh', [...sshArgs(profile), 'command -v tmux >/dev/null 2>&1 && echo yes || echo no']);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      const has = out.includes('yes');
      _tmuxCache.set(key, has);
      resolve(has);
    });
    proc.on('error', () => { _tmuxCache.set(key, false); resolve(false); });
  });
}
```

- [ ] **Step 3: Rewrite the WebSocket connection handler**

Replace the whole `wss.on('connection', (ws, req) => { ... })` block (lines 443-480) with:

```js
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const cols = parseInt(url.searchParams.get('cols'), 10) || 80;
  const rows = parseInt(url.searchParams.get('rows'), 10) || 24;

  // Bind to the profile the terminal was created under (not getActive()), so a
  // reconnect always attaches to the correct remote even after a profile switch.
  const profileName = url.searchParams.get('profile');
  const profile = (profileName && profiles[profileName]) || getActive();
  if (!profile || !profile.host) {
    ws.send('\r\n\x1b[31mNo active profile. Create one first.\x1b[0m\r\n');
    ws.close();
    return;
  }

  const sessionId = sanitizeSessionId(url.searchParams.get('session'));

  let hasTmux = false;
  try { hasTmux = sessionId ? await probeTmux(profile) : false; } catch (_) { hasTmux = false; }

  // The socket may have closed while we were probing.
  if (ws.readyState !== ws.OPEN) return;

  const repoPath = profile.remotePath || '';
  const remoteCmd = (hasTmux && sessionId)
    ? remoteTerminalCommand({ repoPath, sessionName: tmuxSessionName(sessionId) })
    : remoteFallbackCommand({ repoPath });

  if (!hasTmux) {
    // Tell the client persistence is unavailable so it can surface a hint once.
    try { ws.send(JSON.stringify({ type: 'meta', persistent: false })); } catch (_) {}
  }

  let term;
  try {
    term = pty.spawn('ssh', [...sshBaseTerminalArgs(profile), remoteCmd], {
      name: 'xterm-256color',
      cols, rows,
      cwd: os.homedir(),
      env: process.env,
    });
  } catch (err) {
    ws.send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  term.onData((data) => { try { ws.send(data); } catch (_) {} });
  term.onExit(() => { try { ws.close(); } catch (_) {} });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize') { try { term.resize(msg.cols, msg.rows); } catch (_) {} }
  });

  // Killing the local ssh only detaches the tmux client; the remote session (and
  // Claude Code) keeps running and is re-attached on the next connection.
  ws.on('close', () => { try { term.kill(); } catch (_) {} });
});
```

Note: the client sends terminal input/output as strings/binary; `term.onData` may emit a `meta` JSON object above. The client (Task 4) distinguishes a JSON `meta` control message from raw terminal bytes by attempting `JSON.parse` only on string frames that start with `{"type":"meta"`.

- [ ] **Step 4: Verify the server still boots and existing tests pass**

Run: `node -e "require('./server.js'); console.log('required OK')"`
Expected: prints `required OK` with NO server banner (guard intact).

Run: `node --test test/terminal.test.js`
Expected: PASS (7 tests) — helpers unaffected.

- [ ] **Step 5: Smoke-test a live terminal manually**

Run: `node server.js` in one shell; open `http://localhost:4570`, activate a profile whose remote has tmux, open a terminal. On the remote, run `tmux ls`.
Expected: a `grv_<id>` session is listed; the terminal works normally.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Wrap remote terminals in tmux with per-profile detection"
```

---

## Task 3: Server terminal-session endpoints (kill + list)

Add endpoints so the client can kill a session on explicit close and reconcile restored tabs against live sessions.

**Files:**
- Modify: `server.js` — add two routes in the Express routes section (e.g. after `/api/download-dir`, ~line 434).

**Interfaces:**
- Consumes: `sanitizeSessionId`, `tmuxSessionName` (Task 1); `profiles`, `getActive`, `sshArgs`, `spawn`.
- Produces:
  - `DELETE /api/term-session?profile=<name>&session=<id>` → `{ ok: true }`.
  - `GET /api/term-sessions?profile=<name>` → `{ sessions: string[] }` (bare session ids, `grv_` stripped).

- [ ] **Step 1: Write a failing smoke test for input validation**

Add to `test/terminal.test.js`:

```js
test('sanitizeSessionId is used to guard endpoint ids (contract check)', () => {
  // Endpoints must reject ids that fail sanitization before shelling out.
  assert.strictEqual(t.sanitizeSessionId('../evil'), null);
  assert.strictEqual(t.sanitizeSessionId('grv_ok1'), 'grv_ok1');
});
```

- [ ] **Step 2: Run it to confirm it passes (documents the contract)**

Run: `node --test test/terminal.test.js`
Expected: PASS. (This locks the validation contract the endpoints below rely on.)

- [ ] **Step 3: Add a helper to resolve a bound profile for these routes**

Insert near the other Express helpers (before the routes, ~line 214):

```js
// Resolve the profile named in ?profile=, falling back to the active one.
function resolveProfile(name) {
  return (name && profiles[name]) || getActive();
}
```

- [ ] **Step 4: Add the two routes**

Insert after the `/api/download-dir` route (~line 434):

```js
// Kill a terminal's tmux session on the remote (called on explicit tab close).
app.delete('/api/term-session', (req, res) => {
  const sessionId = sanitizeSessionId(req.query.session);
  if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });
  const profile = resolveProfile(req.query.profile);
  if (!profile || !profile.host) return res.status(400).json({ error: 'No profile.' });

  const name = tmuxSessionName(sessionId);
  const proc = spawn('ssh', [...sshArgs(profile), `tmux kill-session -t ${name} 2>/dev/null || true`]);
  proc.on('close', () => res.json({ ok: true }));
  proc.on('error', () => res.json({ ok: true }));   // best-effort cleanup
});

// List live grv_* tmux sessions on the remote so the client can reconcile tabs.
app.get('/api/term-sessions', (req, res) => {
  const profile = resolveProfile(req.query.profile);
  if (!profile || !profile.host) return res.json({ sessions: [] });

  const proc = spawn('ssh', [...sshArgs(profile), `tmux ls -F '#{session_name}' 2>/dev/null || true`]);
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.on('close', () => {
    const sessions = out.split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('grv_'))
      .map(s => s.slice('grv_'.length));
    res.json({ sessions });
  });
  proc.on('error', () => res.json({ sessions: [] }));
});
```

- [ ] **Step 5: Manually verify the endpoints**

With `node server.js` running and a tmux-capable profile active, and a terminal open (session id visible via remote `tmux ls`):

Run: `curl -s 'http://localhost:4570/api/term-sessions?profile=<name>'`
Expected: `{"sessions":["<id>", ...]}` including your open terminal's id.

Run: `curl -s -X DELETE 'http://localhost:4570/api/term-session?profile=<name>&session=<id>'`
Expected: `{"ok":true}`; the remote `tmux ls` no longer lists `grv_<id>`.

- [ ] **Step 6: Commit**

```bash
git add server.js test/terminal.test.js
git commit -m "Add terminal-session kill and list endpoints"
```

---

## Task 4: Client pure helpers (`tabstate.js`) + unit tests

Create a DOM-free module for reconnect backoff, tab serialization, and session reconciliation, loadable in both the browser and node.

**Files:**
- Create: `public/tabstate.js`
- Create: `test/tabstate.test.js`
- Modify: `public/index.html` (load `tabstate.js` before `app.js`)

**Interfaces:**
- Produces (global `TabState` in browser; `module.exports` in node):
  - `nextBackoffDelay(attempt: number): number` — `min(1000 * 2^attempt, 10000)`; `attempt` is 0-based.
  - `serializeTabs(tabs: object[], activeTabId: string|null): { tabs: object[], activeTabId }` — keeps only `terminal` and `explorer` tabs, storing `{ kind, id, label, path?, sessionId?, profileName? }`.
  - `reconcileTerminalTabs(savedTerminals: object[], liveSessionIds: string[]): { alive: object[], dead: object[] }`.

- [ ] **Step 1: Write the failing tests**

Create `test/tabstate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const TS = require('../public/tabstate.js');

test('nextBackoffDelay grows exponentially and caps at 10s', () => {
  assert.strictEqual(TS.nextBackoffDelay(0), 1000);
  assert.strictEqual(TS.nextBackoffDelay(1), 2000);
  assert.strictEqual(TS.nextBackoffDelay(2), 4000);
  assert.strictEqual(TS.nextBackoffDelay(3), 8000);
  assert.strictEqual(TS.nextBackoffDelay(4), 10000);
  assert.strictEqual(TS.nextBackoffDelay(10), 10000);
});

test('serializeTabs keeps only terminal/explorer tabs with persistable fields', () => {
  const tabs = [
    { kind: 'terminal', id: 'term:1', label: 'Terminal 1', sessionId: 'abc', profileName: 'p', term: {}, ws: {} },
    { kind: 'explorer', id: 'file:src/x.js', label: 'x.js', path: 'src/x.js', model: {} },
    { kind: 'diff-staged', id: 'diff:y', label: 'y', path: 'y' },
  ];
  const out = TS.serializeTabs(tabs, 'term:1');
  assert.strictEqual(out.tabs.length, 2);
  assert.deepStrictEqual(out.tabs[0], { kind: 'terminal', id: 'term:1', label: 'Terminal 1', sessionId: 'abc', profileName: 'p' });
  assert.deepStrictEqual(out.tabs[1], { kind: 'explorer', id: 'file:src/x.js', label: 'x.js', path: 'src/x.js' });
  assert.strictEqual(out.activeTabId, 'term:1');
  // no runtime objects leak into storage
  assert.ok(!('term' in out.tabs[0]) && !('ws' in out.tabs[0]) && !('model' in out.tabs[1]));
});

test('reconcileTerminalTabs splits alive vs dead by live session ids', () => {
  const saved = [
    { kind: 'terminal', sessionId: 'a' },
    { kind: 'terminal', sessionId: 'b' },
  ];
  const { alive, dead } = TS.reconcileTerminalTabs(saved, ['a']);
  assert.deepStrictEqual(alive.map(t => t.sessionId), ['a']);
  assert.deepStrictEqual(dead.map(t => t.sessionId), ['b']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/tabstate.test.js`
Expected: FAIL — cannot find module `../public/tabstate.js`.

- [ ] **Step 3: Create `public/tabstate.js`**

```js
// Pure, DOM-free helpers shared by app.js (browser) and node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node
  root.TabState = api;                                                        // browser
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_BACKOFF_MS = 10000;

  function nextBackoffDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
  }

  function serializeTabs(tabs, activeTabId) {
    const out = [];
    for (const tab of tabs) {
      if (tab.kind === 'terminal') {
        out.push({ kind: 'terminal', id: tab.id, label: tab.label, sessionId: tab.sessionId, profileName: tab.profileName });
      } else if (tab.kind === 'explorer') {
        out.push({ kind: 'explorer', id: tab.id, label: tab.label, path: tab.path });
      }
      // diff tabs are transient (derived from git state) — not persisted.
    }
    return { tabs: out, activeTabId };
  }

  function reconcileTerminalTabs(savedTerminals, liveSessionIds) {
    const live = new Set(liveSessionIds);
    const alive = [], dead = [];
    for (const t of savedTerminals) (live.has(t.sessionId) ? alive : dead).push(t);
    return { alive, dead };
  }

  return { nextBackoffDelay, serializeTabs, reconcileTerminalTabs };
});
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/tabstate.test.js`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Load `tabstate.js` before `app.js` in the browser**

In `public/index.html`, the app script is loaded cache-busted at line 171 as
`<script src="app.js?v=25"></script>`. Add `tabstate.js` immediately before it:

```html
<script src="tabstate.js?v=1"></script>
<script src="app.js?v=25"></script>
```

Cache-busting note: whenever a later task edits `public/app.js`, bump its
`?v=` number (e.g. `?v=26`) in the same commit so browsers reload the new file.

- [ ] **Step 6: Commit**

```bash
git add public/tabstate.js test/tabstate.test.js public/index.html
git commit -m "Add pure client tab-state helpers with unit tests"
```

---

## Task 5: Client terminal reconnect (`connectTerminal` + backoff)

Give each terminal tab a stable session id and refactor connection setup into a reusable function that auto-reconnects with backoff.

**Files:**
- Modify: `public/app.js` — `newTerminal` (lines 1100-1135), add `connectTerminal`; use `TabState.nextBackoffDelay`.

**Interfaces:**
- Consumes: `TabState.nextBackoffDelay` (Task 4); `profileState.active`, `currentTheme`, `getFontSize`, `activateTab`, `sendResize`.
- Produces:
  - Each terminal tab object gains: `sessionId: string`, `profileName: string`, `reconnectAttempt: number`, `reconnectTimer: number|null`, `persistent: boolean`, `connState: 'connecting'|'open'|'reconnecting'`.
  - `connectTerminal(tab): void` — opens the WS for a terminal tab, wiring handlers + reconnect.

- [ ] **Step 1: Rewrite `newTerminal` to allocate a session id and delegate to `connectTerminal`**

Replace `newTerminal` (lines 1100-1135) with:

```js
function newTerminal(restore) {
  if (!window.Terminal) { toast('Terminal library not loaded'); return; }
  if (!restore && !profileState.active) { toast('Create/activate a profile first'); return; }

  const n = ++termCounter;
  const id = restore?.id || ('term:' + n);
  const el = document.createElement('div');
  el.className = 'term-instance';
  el.style.display = 'none';
  document.getElementById('terminal-container').appendChild(el);

  const term = new Terminal({
    fontSize: getFontSize(),
    fontFamily: TERM_FONT,
    theme: termTheme(),
    cursorBlink: true,
    scrollback: 8000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const tab = {
    id, kind: 'terminal',
    label: restore?.label || ('Terminal ' + n),
    dirty: false, term, fit, ws: null, el,
    sessionId: restore?.sessionId || crypto.randomUUID().replace(/-/g, ''),
    profileName: restore?.profileName || profileState.active,
    reconnectAttempt: 0, reconnectTimer: null,
    persistent: true, connState: 'connecting',
  };
  tabs.push(tab);
  connectTerminal(tab);
  if (!restore) activateTab(id);
  return tab;
}
```

- [ ] **Step 2: Add `connectTerminal` directly below `newTerminal`**

```js
function connectTerminal(tab) {
  if (tab.disposed) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const term = tab.term, fit = tab.fit;
  const qs = `session=${encodeURIComponent(tab.sessionId)}`
    + `&profile=${encodeURIComponent(tab.profileName || '')}`
    + `&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(`${proto}://${location.host}/terminal?${qs}`);
  tab.ws = ws;
  tab.connState = tab.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
  updateConnIndicator();

  ws.onopen = () => {
    tab.reconnectAttempt = 0;
    tab.connState = 'open';
    updateConnIndicator();
    try { fit.fit(); } catch (_) {}
    sendResize(ws, term);
    term.focus();
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('{"type":"meta"')) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'meta') {
          if (msg.persistent === false && tab.persistent) {
            tab.persistent = false;
            term.write('\r\n\x1b[90m[tmux not found on remote — this session will not survive disconnects]\x1b[0m\r\n');
          }
          return;
        }
      } catch (_) { /* fall through and print as normal output */ }
    }
    term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  };

  ws.onerror = () => { /* onclose will handle reconnect */ };

  ws.onclose = () => {
    if (tab.disposed) return;
    tab.connState = 'reconnecting';
    updateConnIndicator();
    const delay = TabState.nextBackoffDelay(tab.reconnectAttempt);
    if (tab.reconnectAttempt === 0) {
      term.write('\r\n\x1b[33m⟳ reconnecting…\x1b[0m\r\n');
    }
    tab.reconnectAttempt++;
    clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = setTimeout(() => connectTerminal(tab), delay);
  };

  term.onData(d => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
}
```

Note: `term.onData` / `term.onResize` register a new listener each connect. To avoid duplicate listeners across reconnects, move those two registrations OUT of `connectTerminal` into `newTerminal` (register once, referencing `tab.ws` dynamically). Apply this in Step 3.

- [ ] **Step 3: Register `onData`/`onResize` once in `newTerminal`, not per-connect**

Remove the trailing `term.onData(...)` and `term.onResize(...)` lines from `connectTerminal` (Step 2), and add them to `newTerminal` right after `term.open(el);` and before building `tab` — but they need `tab`, so instead add them immediately after `tabs.push(tab);` and before `connectTerminal(tab);`:

```js
  tabs.push(tab);
  term.onData(d => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  connectTerminal(tab);
```

- [ ] **Step 4: Add a temporary no-op `updateConnIndicator` (fleshed out in Task 6)**

So the code runs before Task 6, add near the top of the Terminals section (~line 1077):

```js
// Real implementation added in the status-indicator task; harmless no-op until then.
function updateConnIndicator() {}
```

- [ ] **Step 5: Verify build + manual reconnect**

Run: `node server.js`, open the app, open a terminal, start something visible (e.g. `top`). Turn Wi‑Fi off for ~10s, then on.
Expected: the terminal prints `⟳ reconnecting…`, and within a few seconds of the network returning it re-attaches with `top` still running (tmux path).

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "Auto-reconnect terminals with stable session ids and backoff"
```

---

## Task 6: Client connection indicator, fast reconnect, and fetch timeouts

Surface connection state in the status bar, reconnect instantly on network return, and stop SSH-backed fetches from hanging.

**Files:**
- Modify: `public/index.html` — add a status-bar indicator element.
- Modify: `public/app.js` — implement `updateConnIndicator`; add `online`/`focus` fast reconnect; add `fetchWithTimeout` and route SSH-backed calls through it; refresh sidebar on `online`.

**Interfaces:**
- Consumes: `tabs`, `connectTerminal`, `loadStatus`, `loadTree`.
- Produces:
  - `updateConnIndicator(): void` — sets `#sb-conn` text/class from terminal tab states.
  - `fetchWithTimeout(url, opts?, ms=8000): Promise<Response>` — rejects on timeout via `AbortController`.
  - `reconnectAllTerminals(): void` — cancels backoff and reconnects any non-open terminals now.

- [ ] **Step 1: Add the indicator element to the status bar**

In `public/index.html`, inside `#statusbar` (after the `#new-terminal-btn`, ~line 135), add:

```html
<span class="sb-sep">·</span>
<span class="sb-item sb-conn" id="sb-conn" title="Connection status"></span>
```

- [ ] **Step 2: Implement `updateConnIndicator`**

Replace the temporary no-op from Task 5 Step 4 with:

```js
function updateConnIndicator() {
  const el = document.getElementById('sb-conn');
  if (!el) return;
  const terms = tabs.filter(t => t.kind === 'terminal' && !t.disposed);
  if (terms.length === 0) { el.textContent = ''; el.className = 'sb-item sb-conn'; return; }
  const reconnecting = terms.filter(t => t.connState === 'reconnecting');
  if (reconnecting.length > 0) {
    el.textContent = `⟳ reconnecting${reconnecting.length > 1 ? ' (' + reconnecting.length + ')' : ''}`;
    el.className = 'sb-item sb-conn is-reconnecting';
  } else {
    el.textContent = '● connected';
    el.className = 'sb-item sb-conn is-connected';
  }
}
```

- [ ] **Step 3: Add fast reconnect on network return / focus**

Add near the other `window.addEventListener` calls (e.g. after line 1480):

```js
function reconnectAllTerminals() {
  for (const tab of tabs) {
    if (tab.kind !== 'terminal' || tab.disposed) continue;
    if (tab.ws && tab.ws.readyState === 1) continue;   // already open
    clearTimeout(tab.reconnectTimer);
    tab.reconnectAttempt = 0;                           // reset backoff for an immediate try
    connectTerminal(tab);
  }
}

window.addEventListener('online', () => { reconnectAllTerminals(); loadStatus(); loadTree(); });
window.addEventListener('focus', () => { reconnectAllTerminals(); });
```

- [ ] **Step 4: Add `fetchWithTimeout` and route SSH-backed calls through it**

Add near `init` (~line 203):

```js
// SSH-backed API calls can hang on a dead connection after a network change.
// A timeout makes them reject cleanly into existing catch handlers.
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
```

Then change the SSH-backed data fetches to use it. Update these call sites (leave profile CRUD as plain `fetch`):
- `loadTree` (line 411): `fetch(` → `fetchWithTimeout(`
- `loadStatus` (line 1544): `fetch(` → `fetchWithTimeout(`
- `openFile` (line 874): `fetch(` → `fetchWithTimeout(`
- reload handler (line 901): `fetch(` → `fetchWithTimeout(`
- diff loader (line 918): `fetch(` → `fetchWithTimeout(`
- `loadHeadForTab` (line 937): `fetch(` → `fetchWithTimeout(`
- save (line 1526): `fetchWithTimeout(..., { method: 'PUT', ... }, 20000)` (longer timeout for writes)

Each of these is already inside a `try/catch`; an aborted fetch throws `AbortError`, which the existing `catch` reports via `toast`. No other change needed.

- [ ] **Step 5: Add minimal styling for the indicator**

In `public/style.css`, add near the other `.sb-item` rules:

```css
.sb-conn.is-connected { opacity: 0.7; }
.sb-conn.is-reconnecting { color: #d9a13a; }
```

- [ ] **Step 6: Verify**

Run: `node server.js`, open a terminal. Confirm the status bar shows `● connected`. Toggle Wi‑Fi off: it flips to `⟳ reconnecting`; on return it goes back to `● connected` quickly (focus/online path), and the sidebar refreshes without the UI hanging.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "Add connection indicator, fast reconnect, and fetch timeouts"
```

---

## Task 7: Client tab persistence + restore + explicit-close cleanup

Persist open tabs to localStorage, restore them on load (reconciling terminals against live tmux sessions), and kill the remote session when a terminal tab is closed intentionally.

**Files:**
- Modify: `public/app.js` — add `persistTabs`, `restoreTabs`; call `persistTabs` on open/close/switch; extend `init`; extend `closeTab` (lines 1292-1317) to kill the remote session.

**Interfaces:**
- Consumes: `TabState.serializeTabs`, `TabState.reconcileTerminalTabs` (Task 4); `fetchWithTimeout` (Task 6); `newTerminal(restore)` (Task 5); `openFile`; `tabs`, `activeTabId`, `activateTab`.
- Produces:
  - `persistTabs(): void` — writes `{tabs, activeTabId}` to `localStorage['grv-tabs']` (debounced).
  - `restoreTabs(): Promise<void>` — recreates saved tabs after profiles load.

- [ ] **Step 1: Add `persistTabs` (debounced) near the tab manager (~line 1152)**

```js
let _persistTimer = null;
function persistTabs() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    try {
      const data = TabState.serializeTabs(tabs, activeTabId);
      localStorage.setItem('grv-tabs', JSON.stringify(data));
    } catch (_) {}
  }, 300);
}
```

- [ ] **Step 2: Call `persistTabs` on tab lifecycle changes**

Add a `persistTabs();` call at the end of each of these existing functions:
- `newTerminal` — before `return tab;`
- `openFile` — after `tabs.push(tab); renderTabs();` (inside the `if (!tab)` block, ~line 893)
- `closeTab` — after `tabs.splice(idx, 1);` (~line 1308)
- `activateTab` — at the very end of the function (after the terminal-tab early return path too; simplest is to call it inside the click handlers, but adding one line before each `return` in `activateTab` is error-prone). Instead, add `persistTabs();` as the last line of `renderTabs()` — it runs on every tab add/remove/activate and centralizes persistence.

Concretely, at the end of `renderTabs()` (after the `for` loop, ~line 1180):

```js
  persistTabs();
```

And remove the individual calls suggested for `openFile`/`closeTab`/`newTerminal` IF `renderTabs()` is reliably called by each (it is: `newTerminal`→`activateTab`→`renderTabs`; `openFile`→`renderTabs`; `closeTab`→`renderTabs`/`activateTab`). Keeping only the `renderTabs()` call is DRY. Verify each path calls `renderTabs` before relying solely on it; if a path does not, keep an explicit `persistTabs()` there.

- [ ] **Step 3: Add `restoreTabs`**

Add near `init` (~line 203):

```js
async function restoreTabs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('grv-tabs') || 'null'); } catch (_) { saved = null; }
  if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return;

  const savedTerminals = saved.tabs.filter(t => t.kind === 'terminal');
  const savedFiles = saved.tabs.filter(t => t.kind === 'explorer');

  // Reconcile terminals against live tmux sessions for the active profile.
  let live = [];
  if (savedTerminals.length && profileState.active) {
    try {
      const res = await fetchWithTimeout(`/api/term-sessions?profile=${encodeURIComponent(profileState.active)}`);
      const data = await res.json();
      live = Array.isArray(data.sessions) ? data.sessions : [];
    } catch (_) { live = []; }
  }
  const { alive } = TabState.reconcileTerminalTabs(savedTerminals, live);
  const aliveIds = new Set(alive.map(t => t.sessionId));

  for (const t of savedTerminals) {
    // Re-create tabs whose session still exists (alive), OR whose profile we
    // can't currently verify — new-session -A will simply recreate if needed.
    if (t.profileName === profileState.active && !aliveIds.has(t.sessionId)) continue; // truly dead on active profile
    newTerminal(t);
  }
  for (const f of savedFiles) {
    openFile(f.path);
  }
  if (saved.activeTabId && getTab(saved.activeTabId)) activateTab(saved.activeTabId);
}
```

- [ ] **Step 4: Call `restoreTabs` from `init`**

Change `init` (lines 203-207) to:

```js
async function init() {
  await loadProfiles();   // load profiles first, then fire tree+status in parallel
  loadTree();
  loadStatus();
  restoreTabs();          // recreate saved tabs (terminals re-attach via tmux)
}
```

- [ ] **Step 5: Kill the remote session on explicit close**

In `closeTab` (lines 1292-1317), inside the `if (tab.kind === 'terminal') { ... }` block, before `tabs.splice`, add a best-effort DELETE and cancel any pending reconnect:

```js
  if (tab.kind === 'terminal') {
    tab.disposed = true;
    clearTimeout(tab.reconnectTimer);
    // Best-effort: kill the remote tmux session so it doesn't linger.
    if (tab.sessionId) {
      try {
        fetchWithTimeout(
          `/api/term-session?profile=${encodeURIComponent(tab.profileName || '')}&session=${encodeURIComponent(tab.sessionId)}`,
          { method: 'DELETE' }, 5000,
        ).catch(() => {});
      } catch (_) {}
    }
    if (tab.ws) { tab.ws.onopen = tab.ws.onmessage = tab.ws.onclose = tab.ws.onerror = null; }
    try { tab.ws && tab.ws.close(); } catch (_) {}
    try { tab.term.dispose(); } catch (_) {}
    tab.el?.remove();
  }
```

(Note: `tab.disposed = true` is already set earlier at line 1297; keep only one assignment — leave the existing one and just add the `clearTimeout` + DELETE + null-guard for `tab.ws`.)

- [ ] **Step 6: Verify full lifecycle**

Run: `node server.js`, open two terminals + a file. Note their session ids (`tmux ls` on remote).
- Hard-refresh the browser → both terminals re-attach with state intact; the file reopens; the previously-active tab is active.
- Close one terminal via its ✕ → remote `tmux ls` no longer lists that session.
- Restart `node server.js`, refresh → terminals still restore (state lives on the remote).

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "Persist and restore tabs; kill remote session on explicit close"
```

---

## Task 8: Manual disruption runbook

Document the end-to-end verification so the network-dependent behavior can be re-checked deliberately.

**Files:**
- Create: `docs/RECONNECT-TESTING.md`

- [ ] **Step 1: Write the runbook**

Create `docs/RECONNECT-TESTING.md`:

```markdown
# Terminal Reconnect — Manual Test Runbook

Prereqs: a profile whose remote host has `tmux` installed, and one that does not
(for the fallback test). Start the app with `npm start` and open the UI.

## 1. Survive a network change (core)
1. Open a terminal, run `claude` (or `top` as a stand-in).
2. Toggle VPN / turn Wi‑Fi off ~15s, then on.
   - Expect: `⟳ reconnecting…` appears; status bar shows `⟳ reconnecting`.
   - On return: terminal re-attaches, the process is still running, status bar
     shows `● connected`.

## 2. Survive a browser reload
1. With terminals + a file open, hard-refresh (Cmd/Ctrl+Shift+R).
   - Expect: tabs restore; terminals re-attach with scrollback; the file reopens;
     the previously-active tab is active.

## 3. Survive a node restart
1. Kill `node server.js`; start it again; refresh the browser.
   - Expect: terminals restore (state lives in tmux on the remote).

## 4. Explicit close cleans up
1. Close a terminal tab with its ✕.
2. On the remote: `tmux ls`.
   - Expect: that `grv_<id>` session is gone.

## 5. tmux-absent fallback
1. Activate a profile whose remote lacks tmux; open a terminal.
   - Expect: a one-line hint that the session will not survive disconnects.
   - A network drop still reconnects the transport, but starts a fresh shell.

## 6. UI does not freeze
1. During a drop, click around the explorer / source control.
   - Expect: requests fail via toast within ~8s rather than hanging the UI; on
     reconnect the sidebar refreshes automatically.
```

- [ ] **Step 2: Run the full unit suite once more**

Run: `npm test`
Expected: PASS — all tests in `test/terminal.test.js` and `test/tabstate.test.js` green.

- [ ] **Step 3: Commit**

```bash
git add docs/RECONNECT-TESTING.md
git commit -m "Add manual reconnect testing runbook"
```

---

## Self-Review Notes

- **Spec coverage:** tmux persistence + fallback (Tasks 1-2), session id + binding (Tasks 1,2,5), kill/list endpoints (Task 3), reconnect + backoff (Task 5), online/focus fast reconnect + indicator + fetch timeouts (Task 6), tab persistence/restore + reconcile + explicit-close kill (Task 7), fallback hint (Task 2 meta + Task 5 handler), testing (unit Tasks 1/4, runbook Task 8). All spec sections mapped.
- **Type consistency:** `sessionId` (bare, sanitized) vs `tmuxSessionName` (`grv_`-prefixed) are used consistently — the client stores/sends bare ids; the server prefixes only when building tmux commands and strips the prefix when listing. `connState` values `'connecting'|'open'|'reconnecting'` are set in `connectTerminal` and read in `updateConnIndicator`. `newTerminal(restore)` restore-descriptor fields (`id,label,sessionId,profileName`) match `serializeTabs` output.
- **Known nuance:** in Task 7 Step 2, prefer the single `persistTabs()` call inside `renderTabs()`; verify each mutation path calls `renderTabs` before removing the per-site calls.
```
