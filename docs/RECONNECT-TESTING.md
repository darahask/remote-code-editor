# Terminal Reconnect — Manual Test Runbook

Prereqs: a profile whose remote host has `tmux` installed, and one that does not
(for the fallback test). Start the app with `npm start` and open the UI. (Note: this project
also provides `./grv.sh restart` for server lifecycle management.)

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
