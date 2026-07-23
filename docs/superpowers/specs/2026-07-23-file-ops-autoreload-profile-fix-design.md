# File Operations, Auto-Reload, and Profile-Switch Fix — Design

Date: 2026-07-23

## Summary

Three improvements to the remote code editor's Explorer and profile handling:

1. **Profile bug fix** — a newly added profile must appear in the list immediately, and clicking a profile must switch to it (rebinding tree + git status) without a page reload.
2. **Auto-reload** — poll the file tree and git status every ~10s so new/changed/deleted files on the remote show up without a manual refresh, without disrupting the user.
3. **File operations** — a VSCode-style right-click context menu on the file tree (full operation set) plus drag-and-drop move.

Terminal copy behavior is explicitly **out of scope**: Shift-select already copies to the local clipboard and stays as-is.

## Context

- Backend: `server.js` (Express + node-pty/ssh). File tree comes from `GET /api/tree`; file content via `GET/PUT /api/file-content`; downloads via `/api/download` and `/api/download-dir`. There are currently **no** create/rename/delete/move/copy endpoints.
- Frontend: `public/app.js`. Tree rendered by `renderTree()`/`renderNodes()` (lazy: children built on first expand). `expandedDirs` is module-level state already preserved across re-render. Profiles managed by `loadProfiles`/`renderProfileList`/`activateProfile`/`deleteProfile` and the `pf-save` handler.
- Pure helpers live in `public/tabstate.js` (UMD, unit-tested with `node --test`).
- Path safety: session ids validated `^[A-Za-z0-9_]+$`; remote paths quoted via `shQuote`.
- Run the server with `./grv.sh {start|stop|restart|status}` (never `node server.js` directly, no sudo).

## 1. Profile list / switch fix

The client add/switch path reads correct on inspection: `pf-save` sets `profileState.profiles[name]` then calls `renderProfileList()`; a row click calls `activateProfile(name)` which POSTs `/api/profiles/:name/activate`, updates `profileState.active`, and reloads tree + status. Because nothing is obviously broken, the fix is **investigation-first**:

- Reproduce live with chrome-devtools (add a profile, observe the list; click a profile, observe the switch).
- Root-cause the actual defect (candidates: stale cached `app.js`, a render/state desync, an event handler not firing, or an error thrown mid-handler that aborts the render).
- Patch the real cause. **No blind edits.**

Target behavior:
- A saved profile appears in `#pp-list` instantly.
- Clicking a profile row activates it and rebinds tree + git status without a page reload.

## 2. Auto-reload (non-destructive, ~10s)

A polling loop refreshes tree + git status so remote changes appear automatically.

- Interval: ~10s (`setInterval`).
- Calls `loadStatus()` and a **non-destructive tree refresh**.
- **Non-destructive** means preserve, across the refresh: expanded folders (`expandedDirs`, already module state), scroll position of the tree container, and the current selection.
- **Pause** the loop when `document.hidden` (tab not visible) or the browser is offline; resume on visibility/focus and `online` (reuse existing hooks).
- **Coalesce**: skip a scheduled poll if a previous tree/status request is still in flight.
- **Suppress the tree refresh** while an inline rename / new-file / new-folder input is open, so polling can't destroy an in-progress edit. Git-status polling may still run.
- Editor tabs are never touched by the poll (it only re-renders the Explorer), so editing a file is unaffected.

## 3. File operations

### Server — new endpoints

All are **profile-scoped** (resolve profile from `?profile=` or active), run over ssh with `shQuote`, and **validate the relative path before shelling out**: reject absolute paths, reject any `..` segment, and confirm the resolved absolute path stays within the profile's `remotePath`. On bad input, respond `400` before any spawn.

- `POST /api/fs/mkdir` — `{ path }` → `mkdir -p` (New Folder).
- `POST /api/fs/create` — `{ path }` → create empty file (`touch`), fail if it already exists (New File).
- `POST /api/fs/rename` — `{ src, dest }` → `mv` (Rename **and** Move — one op). Reject dest that collides unless intended.
- `POST /api/fs/delete` — `{ path }` → `rm -rf` (Delete; client confirms first).
- `POST /api/fs/copy` — `{ src, dest }` → `cp -r` (Copy / Duplicate / paste-as-copy).

Path validation and command construction are factored into small pure functions exported from `server.js` (like `sanitizeSessionId`) so they can be unit-tested hermetically.

### Client — context menu + interactions

Right-click a tree row (file or dir) opens a context menu with the **full VSCode set**:
New File, New Folder, Rename, Delete, Cut, Copy, Paste, Duplicate, Copy Path, Copy Relative Path, Download, Reveal.

Right-click empty Explorer area → New File, New Folder, Paste at repo root.

- **New File / New Folder / Rename** use inline VSCode-style text inputs rendered into the tree.
- **Cut / Copy** set an internal clipboard object `{ mode: 'cut'|'copy', path }`; **Paste** into a folder performs move (`rename`) or copy (`copy`). A cut clipboard is cleared after a successful paste.
- **Duplicate** = `copy` into the same directory with a ` copy` suffix (deduplicated if the name already exists).
- **Copy Path** = absolute remote path; **Copy Relative Path** = path relative to `remotePath`. Both write to the clipboard.
- **Download** reuses `/api/download` (file) and `/api/download-dir` (folder).
- **Reveal** uses the existing `revealInTree`.
- **Drag-and-drop**: dragging a row onto a folder row performs a move (`rename`). Guard rejects dropping a node onto itself or into one of its own descendants.
- After any successful op: run the non-destructive tree refresh and reveal/select the affected path.

**Scope:** single item at a time (no multi-select).

## Testing

- **Server (hermetic, `node --test`):** path-validation rejects `..`, absolute paths, and escapes outside `remotePath`; command construction per op asserts correct `shQuote`ing; endpoint tests return `400` before spawn on bad input — mirroring `test/terminal.test.js` and `test/endpoints.test.js`.
- **Client (pure helpers, UMD like `tabstate.js`, `node --test`):** path-join, drag "is-descendant" guard, duplicate-name suffixing.
- **Live (chrome-devtools):** every context-menu op, drag-drop move, auto-reload picking up an externally-created file, and the profile add/switch fix.

## Out of scope

- Terminal copy/selection changes (Shift-select retained).
- Multi-select operations in the tree.
