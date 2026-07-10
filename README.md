# Remote Code Editor

A VS Code–style web editor for a git repo that lives on a **remote server**,
accessed over SSH. Runs entirely on your laptop; the remote only needs `git`,
a shell, and SSH access — **nothing to install there** (no Node.js on the remote).

## Features

- **Profiles** — save multiple remote servers and switch between them from the
  status bar. A profile is just a name + SSH host + remote repo path.
- **Explorer** — lazy-loaded file tree (handles huge repos), fuzzy quick-open
  search, and a "Show ignored files" toggle.
- **Editor** — Monaco (the editor behind VS Code) with:
  - **Multiple tabs** (open several files/diffs/terminals at once)
  - **Dirty-diff gutter** — green/blue/red bars show lines changed vs HEAD,
    live as you type; click a bar to jump to that change in the diff
  - **Minimap** overview, adjustable **font size** (12/13/14/16)
  - Edit and save straight back to the remote (Ctrl/Cmd+S)
- **Source Control** — Staged / Changes / Untracked, stage/unstage with +/−,
  side-by-side diffs.
- **Markdown preview** — rendered Markdown with **Mermaid** diagrams, in a
  centered column with drag-adjustable width.
- **Terminals** — one or more full interactive SSH terminals as tabs
  (PTY-backed, so `vim`, `htop`, etc. work). Open with the **▮ Terminal**
  button in the status bar or **Ctrl+`**.
- **Resizable sidebar**, warm light theme.

## 1. Requirements

- **Node.js** on your laptop (not on the remote).
- SSH access to the remote box.
- Git already installed on the remote.

## 2. Set up SSH key auth (important)

This app uses your system `ssh` — it honors your `~/.ssh/config` (aliases,
jump hosts, etc.) and your SSH agent. It does **not** prompt for or store
passwords. So you must be able to SSH into the remote **without a password**,
using a key.

If you can't yet, copy your public key to the server once:

```bash
ssh-copy-id your-user@your-server      # or: ssh-copy-id my-ssh-alias
```

After that, `ssh your-user@your-server` should log you straight in. If it does,
this app will too. (Aliases defined in `~/.ssh/config` work as the host — e.g.
if `ssh ddev` works, use `ddev` as the profile host.)

## 3. Install & run

```bash
npm install
npm start
```

Then open **http://localhost:4570**.

> `node-pty` (used for terminals) builds a small native module on `npm install`.
> If your package manager blocks install scripts, approve it
> (`npm install-scripts approve node-pty`) and re-run `npm install`.

### Run in the background

Use the `grv.sh` control script to run the server detached and stop it safely:

```bash
./grv.sh start     # launch in the background (logs → grv.log)
./grv.sh status    # is it running?
./grv.sh stop      # stop it
./grv.sh restart
```

`stop` only kills the process it started: it tracks the PID in `.grv.pid` and
verifies that PID is still *our* `node server.js` (matching command and working
directory) before signalling it — so it never kills an unrelated process that
happens to reuse the PID or hold the port. Set a different port with
`PORT=5000 ./grv.sh start`.

## 4. Create a profile

On first launch the Profiles panel opens automatically. Add a profile with:

- **Name** — anything, e.g. `my-server`
- **SSH host / alias** — an IP/hostname, or an alias from `~/.ssh/config` (e.g. `ddev`)
- **Username** — optional if your `~/.ssh/config` already sets it
- **Remote path** — absolute path to the git repo on the remote, e.g. `/home/you/project`

Profiles are stored in `profiles.json` (gitignored). Switch or add more anytime
from the status bar. Change the port with `PORT=5000 npm start` if needed.

## Notes

- `profiles.json` and `config.json` are gitignored — they hold your server
  details. Don't commit them.
- Every action (status/diff/stage/unstage/read/save) runs a real command on the
  remote over SSH — there's no local clone; nothing is synced or cached beyond
  what's on screen.
- Saving writes directly to the remote working tree. Undo is via git itself
  (`git checkout -- <file>` on the remote).
- **Scope:** this is a browse/edit/stage/diff tool + terminals. It intentionally
  does not commit, push/pull, or switch branches from the UI — use a terminal
  tab for that.

## Troubleshooting

- **Can't connect / "SSH error":** confirm `ssh <host>` works from your terminal
  with no password prompt. If it prompts, run `ssh-copy-id` (see step 2).
- **Terminal won't open:** make sure `node-pty` built (see step 3).
