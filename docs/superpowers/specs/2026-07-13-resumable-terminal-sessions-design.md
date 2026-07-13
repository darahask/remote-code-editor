# Resumable Terminal Sessions Across Network Changes

**Date:** 2026-07-13
**Status:** Approved, pending implementation plan

## Problem

The remote code editor runs `node server.js` on the user's **laptop**. The
browser connects to `localhost:4570`; only SSH reaches out to the remote. When
the user connects to a VPN or changes networks, the laptop's source IP changes,
the SSH TCP connection breaks, and:

- The remote shell — a child of the remote `sshd` — is killed, taking any
  running Claude Code session with it.
- The server (`server.js:479`) kills the PTY on WebSocket close, so there is
  nothing left to reconnect to.
- The client (`app.js:1126`) only prints `[connection closed]`; nothing retries.
- Tabs live only in memory, so a browser reload starts empty.

The node server itself never crashes (confirmed: PID stays alive, port stays
bound). The failure is entirely at the SSH/remote-shell and browser layers.

## Goal

After a network change, VPN switch, browser reload, or even a node restart, the
user's terminal (Claude Code) sessions are preserved and automatically
re-attached, and the UI shows a "reconnecting" state instead of freezing.

## Core Idea

Run each terminal's shell inside a **named tmux session on the remote**. tmux is
a server process that owns the shell independently of any SSH connection. When
SSH drops, the tmux *client* dies but the *session* (and Claude Code) keeps
running. Reconnecting runs `tmux attach`, and tmux repaints the screen — the
user is back exactly where they left off.

```
Browser tab ──WS──> node (laptop) ──ssh──> [ tmux session grv_<id> ] ── $SHELL ── claude
   (stable sessionId per tab)                 ^ survives SSH drop; re-attached on reconnect
```

Because the state lives on the remote, this yields resume across network
changes, browser reloads, and node restarts with one mechanism.

## Decisions

- **tmux with graceful fallback:** prefer tmux; if the remote has no tmux, fall
  back to today's non-persistent one-shot shell so the tool still works.
- **Scope:** terminal survival + auto-reconnect + UI "reconnecting" state +
  editor tab restoration on reload.
- **Explicit tab close kills the remote tmux session** (drops ≠ close: only an
  intentional close terminates the session, so the remote does not accumulate
  zombies).
- **Each terminal is bound to the profile it was created under**, so reconnect
  always attaches to the correct remote even if the active profile changed.

## Server Changes (`server.js`)

### tmux detection (cached per profile)
On the first terminal for a profile, run `command -v tmux >/dev/null` over SSH.
Cache the boolean keyed by `user@host` so repeated terminals do not re-probe.

### Session-wrapped terminal args
Add a function that builds the remote command:

- **tmux present:** `cd <repo> 2>/dev/null; exec tmux new-session -A -s grv_<id> $SHELL -l`
  - `-A` attaches if the session exists, else creates it.
  - On create, the pane command is a login shell (`$SHELL -l`) started in the
    repo directory; on attach, the command arg is ignored (tmux reattaches).
- **tmux absent:** fall back to the existing `cd <repo>; exec $SHELL -l`
  (one-shot, no persistence).

### WebSocket handler
- Read `session` and `profile` from the query string
  (`/terminal?session=<id>&profile=<name>&cols=&rows=`).
- Resolve the named profile (not `getActive()`), so a terminal always reconnects
  to the remote it was created against.
- Validate the session id to `[A-Za-z0-9_]+` before it is interpolated into any
  shell command; reject otherwise.
- Keep `ws.on('close') → term.kill()` — now safe, since killing the local ssh
  merely detaches the tmux client; the remote session persists.

### New endpoints
- `DELETE /api/term-session?profile=<name>&session=<id>` — runs
  `tmux kill-session -t grv_<id>` on the bound remote. Called when the user
  intentionally closes a terminal tab.
- `GET /api/term-sessions?profile=<name>` — runs `tmux ls` (tolerating "no
  server running"), filters to `grv_*`, and returns the live session ids so the
  client can reconcile restored tabs.

## Client Changes (`public/app.js`)

### Stable session id per terminal tab
Generate `crypto.randomUUID()` (dashes stripped / sanitized to `[A-Za-z0-9_]`)
once when the tab is created; reuse it for every connection and reconnection.
Store `sessionId` and `profileName` on the tab object.

### `connectTerminal(tab)`
Extract WebSocket setup from `newTerminal()` into a reusable function used for
both first connect and reconnect. It:

- Opens `WebSocket(.../terminal?session=<id>&profile=<name>&cols=&rows=)`.
- Wires `onopen` (fit + send resize), `onmessage` (write to xterm), `onerror`.
- On an **unexpected** `onclose` (user-initiated closes already null the handlers
  in `closeTab`), shows `⟳ reconnecting…` in the terminal and retries with
  exponential backoff (1s → 2s → 4s … capped ~10s).
- Also triggers an **immediate** reconnect on `window` `online` and tab `focus`
  events, so reconnection is instant once the VPN/network is back rather than
  waiting out a backoff interval.
- Stops retrying when the tab is disposed or its profile has been deleted.

### Tab persistence (`localStorage`)
Persist (debounced, on open/close/switch):

- Terminal tabs: `{ id, sessionId, label, profileName, kind: 'terminal' }`
- Editor tabs: `{ path, kind }`
- The active tab id.

On load, restore tabs: terminal tabs call `connectTerminal` (which re-attaches
via tmux); editor tabs re-fetch their content. Terminal tabs are reconciled
against `GET /api/term-sessions` — a tab whose tmux session no longer exists is
shown as ended rather than silently reborn as an empty shell.

## UI Resilience ("doesn't get stuck")

- **Connection indicator** in the status bar reflecting terminal state:
  *connected* / *reconnecting*.
- **`fetchWithTimeout` wrapper** around the SSH-backed `/api/*` calls (git
  status, tree, file content, diffs). A network blip currently leaves these
  hanging on a dead SSH pipe; a timeout makes them reject cleanly into existing
  `catch` handlers instead of spinning forever. On the `online` event, the
  sidebar (status + tree) refreshes automatically.

## Error Handling & Edge Cases

- **No tmux on remote:** transport still reconnects, but each reconnect is a
  fresh shell (no Claude Code survival). Surface this once, subtly, so the user
  knows persistence is unavailable.
- **Backoff termination:** stop on tab disposed or profile deleted; otherwise
  keep retrying at the capped interval.
- **Resize on reconnect:** the existing `fit()` in `onopen` re-sends terminal
  size, so tmux resizes correctly on each attach.
- **Multiple terminals:** each has its own tmux session and its own independent
  reconnect loop.
- **Profile switch while a terminal is open:** the terminal stays bound to its
  own profile and keeps attaching to the correct remote.
- **Quoting/safety:** session ids are sanitized on both client and server before
  entering any shell command; profile paths continue to use existing `shQuote`.

## Testing

Because this is inherently about network disruption, most verification is a
scripted manual runbook, plus a few pure-function unit tests.

**Manual runbook:**
1. Start Claude Code in a terminal tab; drop the network / toggle VPN; confirm
   auto-reattach with session state intact.
2. Hard-refresh the browser; confirm tabs restore and terminals re-attach.
3. Kill and restart `node server.js`; confirm terminal sessions survive
   (state lives on the remote).
4. Close a terminal tab explicitly; confirm the remote `tmux` session is gone
   (`tmux ls` no longer lists it).
5. Fallback path: with tmux uninstalled on the remote, confirm terminals still
   open (no persistence) and the "persistence unavailable" note appears.

**Unit-testable pieces:**
- Session-id sanitization (`[A-Za-z0-9_]` enforcement, rejection of bad input).
- tmux terminal-arg construction (correct command for present vs. absent tmux).

## Out of Scope

- Persisting editor **unsaved buffer contents** across reloads (only which files
  are open is restored).
- Sharing one tmux session across multiple browser tabs/windows simultaneously
  (each terminal tab owns one session).
- Replacing SSH transport with mosh (considered; rejected due to install burden
  on both ends and no reload/restart persistence without tmux anyway).
