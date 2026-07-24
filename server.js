// server.js — uses the system `ssh` binary so ~/.ssh/config aliases just work.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

// Timestamped server log line (lands in grv.log). Keep terse — this is an
// operational breadcrumb trail for diagnosing terminal/ssh connectivity.
function slog(...args) { console.log(new Date().toISOString(), ...args); }

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const PROFILES_PATH = path.join(__dirname, 'profiles.json');

function readProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function writeProfiles() {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify({ _active: activeProfileName, ...profiles }, null, 2), 'utf8');
}

const _saved = readProfiles();
let activeProfileName = _saved._active || null;
const profiles = Object.fromEntries(Object.entries(_saved).filter(([k]) => k !== '_active'));

function getActive() {
  return activeProfileName ? profiles[activeProfileName] : null;
}

// ---------------------------------------------------------------------------
// SSH via system binary (respects ~/.ssh/config, agents, aliases)
// ---------------------------------------------------------------------------

function ctlPath(profile) {
  const key = (profile.username ? profile.username + '@' : '') + profile.host;
  return path.join(os.tmpdir(), `grv-ctl-${key}`);
}

// Keep every ssh connection — above all a shared ControlMaster — from wedging
// on a dropped/hung network (e.g. a VPN switch). Without this, a master whose
// TCP silently died stays alive holding its socket, and every multiplexed
// client after it (terminal, tree, tmux probe) hangs forever on that socket —
// ConnectTimeout can't help because connecting to the local socket succeeds.
// ServerAlive makes the connection self-terminate after ~15s (5s × 3) of
// silence so the master dies and is recreated; ConnectTimeout bounds a fresh
// connect. Applied to BOTH arg builders so whichever ssh creates the master
// gives it a keepalive.
// Detection window = ServerAliveInterval × ServerAliveCountMax ≈ 6s: after ~6s
// of silence the ssh gives up, closing the pty so the client can reconnect.
// Kept aggressive on purpose — tmux makes reattach lossless, so a false trip on
// a latency spike costs only a brief "reconnecting" flicker. Tune here.
const SSH_KEEPALIVE = [
  '-o', 'ServerAliveInterval=3',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ConnectTimeout=8',
];

function sshArgs(profile) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${ctlPath(profile)}`,
    '-o', 'ControlPersist=120',
    ...SSH_KEEPALIVE,
  ];
  if (profile.port && Number(profile.port) !== 22) args.push('-p', String(profile.port));
  args.push(profile.username ? `${profile.username}@${profile.host}` : profile.host);
  return args;
}

// Base args for an interactive login shell over SSH (no trailing command — the
// caller appends the remote command it wants to run).
function sshBaseTerminalArgs(profile) {
  const args = [
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    // A terminal uses its OWN dedicated ssh connection — NOT the shared
    // ControlMaster. This is essential for reconnect: a multiplexed client
    // ignores its own ServerAliveInterval (only the master's keepalive governs
    // the link), so a terminal riding a master hangs indefinitely when the
    // network drops. Standalone, the terminal's own ServerAliveInterval reliably
    // tears the ssh down ~15s after a drop → the pty closes → the browser
    // WebSocket fires onclose → the client reconnect loop runs.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    ...SSH_KEEPALIVE,
  ];
  if (profile.port && Number(profile.port) !== 22) args.push('-p', String(profile.port));
  args.push(profile.username ? `${profile.username}@${profile.host}` : profile.host);
  return args;
}

// Cache tmux availability per user@host so we probe the remote only once.
const _tmuxCache = new Map();

function profileKey(profile) {
  return (profile.username ? profile.username + '@' : '') + profile.host;
}

function probeTmux(profile) {
  const key = profileKey(profile);
  if (_tmuxCache.has(key)) return Promise.resolve(_tmuxCache.get(key));
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn('ssh', [...sshArgs(profile), 'command -v tmux >/dev/null 2>&1 && echo yes || echo no']);
    let out = '', done = false;
    const finish = (val, why) => {
      if (done) return; done = true; clearTimeout(timer);
      slog(`probeTmux ${key} -> ${val} (${why}, ${Date.now() - t0}ms)`);
      resolve(val);
    };
    // Hard backstop: a wedged ControlMaster can hang a multiplexed probe
    // indefinitely (ConnectTimeout doesn't bound it), which would freeze
    // terminal startup. Kill and fall back rather than hang forever.
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(false, 'timeout'); }, 12000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', (code) => {
      // Only cache a definitive answer. A blip in the ssh connection itself
      // (non-zero exit, no recognizable token, timeout) must NOT be cached as
      // "no tmux" — that would permanently downgrade the host to one-shot
      // shells until the server restarts. Re-probe next time instead.
      if (out.includes('yes')) { _tmuxCache.set(key, true); finish(true, 'yes'); }
      else if (out.includes('no') && code === 0) { _tmuxCache.set(key, false); finish(false, 'no'); }
      else finish(false, `indeterminate code=${code}`);
    });
    proc.on('error', (e) => finish(false, 'error:' + e.message));
  });
}

// Tear down a specific profile's SSH ControlMaster. Takes the profile
// explicitly (never getActive()) so callers control exactly which master dies.
function resetConnection(profile) {
  if (!profile || !profile.host) return;
  spawn('ssh', ['-o', `ControlPath=${ctlPath(profile)}`, '-O', 'exit', profile.host])
    .on('error', () => {});
}

// Run a command against a specific profile. Capturing the profile once (rather
// than re-reading getActive() across awaits) guarantees a request never mixes
// two profiles if the active profile is switched mid-flight.
function runWith(profile, cmd) {
  if (!profile || !profile.host) return Promise.reject(new Error('No active profile configured.'));
  if (!profile.remotePath)       return Promise.reject(new Error('No remotePath set for this profile.'));

  return new Promise((resolve, reject) => {
    const fullCmd = `cd ${shQuote(profile.remotePath)} && ${cmd}`;
    const proc = spawn('ssh', [...sshArgs(profile), fullCmd]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('close', code => resolve({ stdout, stderr, code }));
    proc.on('error', err => reject(err));
  });
}

function run(cmd) { return runWith(getActive(), cmd); }
function git(args) { return run(`git ${args}`); }
function gitWith(profile, args) { return runWith(profile, `git ${args}`); }

function writeRemoteFile(remotePath, content) {
  const profile = getActive();
  if (!profile) return Promise.reject(new Error('No active profile.'));
  return writeRemoteBuffer(profile, remotePath, Buffer.from(content, 'utf8'));
}

// Binary-safe write: pipes a raw Buffer into `cat > path` over SSH. Takes the
// profile explicitly so uploads can't be redirected by a mid-flight switch.
function writeRemoteBuffer(profile, remotePath, buffer) {
  if (!profile || !profile.host) return Promise.reject(new Error('No active profile.'));
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [...sshArgs(profile), `cat > ${shQuote(remotePath)}`]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || 'Write failed'));
      resolve();
    });
    proc.on('error', reject);
    proc.stdin.end(buffer);
  });
}

function remoteAbsPath(profile, relPath) {
  return profile.remotePath.replace(/\/+$/, '') + '/' + relPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function isSafePath(p) {
  if (!p || typeof p !== 'string' || p.includes('\0') || p.startsWith('/')) return false;
  const parts = p.split('/');
  return !parts.includes('..') && !parts.includes('.');
}

// Build a shell command for a filesystem operation on tree-relative, already
// isSafePath-validated paths. Runs under `cd <remotePath>` (see runWith), so
// relative paths resolve inside the repo. rename/copy refuse to clobber an
// existing destination. Throws on an unknown op.
function fsCommand(op, { src, dest } = {}) {
  const s = shQuote(src);
  const d = dest != null ? shQuote(dest) : null;
  switch (op) {
    // `--` ends option parsing so a path beginning with `-` (e.g. a file named
    // "-rf") is treated as an operand, never a flag.
    case 'mkdir':  return `mkdir -p -- ${s}`;
    case 'create': return `if [ -e ${s} ]; then echo 'File already exists' >&2; exit 1; fi; : > ${s}`;
    case 'delete': return `rm -rf -- ${s}`;
    case 'rename': return `if [ -e ${d} ]; then echo 'Target already exists' >&2; exit 1; fi; mv -- ${s} ${d}`;
    case 'copy':   return `if [ -e ${d} ]; then echo 'Target already exists' >&2; exit 1; fi; cp -r -- ${s} ${d}`;
    default: throw new Error(`Unknown fs op: ${op}`);
  }
}

function guessLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
    '.php': 'php', '.sh': 'shell', '.bash': 'shell', '.yml': 'yaml', '.yaml': 'yaml',
    '.json': 'json', '.html': 'html', '.css': 'css', '.scss': 'scss', '.md': 'markdown',
    '.sql': 'sql', '.xml': 'xml', '.vue': 'html', '.kt': 'kotlin', '.swift': 'swift',
  })[ext] || 'plaintext';
}

// ---------------------------------------------------------------------------
// Git status parsing
// ---------------------------------------------------------------------------

function parseStatus(raw) {
  const staged = [], unstaged = [], untracked = [];
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i++];
    const x = entry[0], y = entry[1], filePath = entry.slice(3);
    let origPath = null;
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') origPath = tokens[i++];
    if (x === '?' && y === '?') { untracked.push({ path: filePath, status: '?', label: 'U' }); continue; }
    if (x !== ' ' && x !== '?') staged.push({ path: filePath, origPath, status: x, label: x });
    if (y !== ' ' && y !== '?') unstaged.push({ path: filePath, origPath, status: y, label: y });
  }
  return { staged, unstaged, untracked };
}

function buildTree(paths) {
  const root = { type: 'dir', name: '', children: {} };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node.children[part] = { type: 'file', name: part, path: p };
      } else {
        node.children[part] ??= { type: 'dir', name: part, children: {} };
        node = node.children[part];
      }
    });
  }
  return root;
}

function treeToJSON(node, ignoredSet) {
  if (node.type === 'file') return { type: 'file', name: node.name, path: node.path, ignored: ignoredSet.has(node.path) };
  const kids = Object.values(node.children)
    .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
    .map(c => treeToJSON(c, ignoredSet));
  return { type: 'dir', name: node.name, children: kids, ignored: kids.length > 0 && kids.every(k => k.ignored) };
}

// Resolve the profile named in ?profile=, falling back to the active one.
function resolveProfile(name) {
  return (name && profiles[name]) || getActive();
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve xterm assets locally (cdnjs serves them with a MIME type the browser's
// ORB blocks), so vendor them from node_modules.
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

// Profiles
app.get('/api/profiles', (req, res) => res.json({ profiles, active: activeProfileName }));

app.post('/api/profiles', (req, res) => {
  const { name, host, username, remotePath } = req.body || {};
  if (!name || !host || !remotePath) return res.status(400).json({ error: 'name, host, and remotePath are required.' });
  if (name === '_active') return res.status(400).json({ error: 'Reserved name.' });
  profiles[name] = { host, username: username || '', remotePath };
  writeProfiles();
  res.json({ ok: true });
});

app.delete('/api/profiles/:name', (req, res) => {
  const { name } = req.params;
  if (!profiles[name]) return res.status(404).json({ error: 'Not found.' });
  const removed = profiles[name];           // capture before mutating
  delete profiles[name];
  if (activeProfileName === name) activeProfileName = Object.keys(profiles)[0] || null;
  resetConnection(removed);                 // tear down the DELETED profile's master
  writeProfiles();
  res.json({ ok: true });
});

app.post('/api/profiles/:name/activate', (req, res) => {
  const { name } = req.params;
  if (!profiles[name]) return res.status(404).json({ error: 'Not found.' });
  // No resetConnection here: each profile has its own ControlPath (keyed by
  // user@host), so switching doesn't disturb another profile's master, and
  // tearing one down mid-flight would break in-flight commands for no reason.
  if (activeProfileName !== name) { activeProfileName = name; writeProfiles(); }
  res.json({ ok: true });
});

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

// Git
app.get('/api/status', async (req, res) => {
  const profile = getActive();               // capture once for the whole request
  try {
    const [branchRes, statusRes] = await Promise.all([
      gitWith(profile, 'rev-parse --abbrev-ref HEAD'),
      gitWith(profile, 'status --porcelain -z'),
    ]);
    if (statusRes.code !== 0) return res.status(500).json({ error: statusRes.stderr || 'git status failed' });
    res.json({ branch: branchRes.stdout.trim() || '(unknown)', remotePath: profile?.remotePath || '', ...parseStatus(statusRes.stdout) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/file-diff', async (req, res) => {
  const filePath = req.query.path;
  const mode = req.query.mode === 'staged' ? 'staged' : 'unstaged';
  if (!isSafePath(filePath)) return res.status(400).json({ error: 'Invalid path' });
  const profile = getActive();               // capture once so both sides read the same profile
  try {
    let original = '', modified = '';
    if (mode === 'staged') {
      const [h, idx] = await Promise.all([gitWith(profile, `show HEAD:${shQuote(filePath)}`), gitWith(profile, `show :${shQuote(filePath)}`)]);
      original = h.code === 0 ? h.stdout : '';
      modified = idx.code === 0 ? idx.stdout : '';
    } else {
      const [idx, wt] = await Promise.all([gitWith(profile, `show :${shQuote(filePath)}`), runWith(profile, `cat ${shQuote(filePath)}`)]);
      original = idx.code === 0 ? idx.stdout : '';
      modified = wt.code === 0 ? wt.stdout : '';
    }
    res.json({ original, modified, language: guessLanguage(filePath) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// HEAD (committed) version of a file, for dirty-diff gutter decorations.
// Returns { content, tracked }. tracked=false means the file isn't in HEAD.
app.get('/api/file-head', async (req, res) => {
  const filePath = req.query.path;
  if (!isSafePath(filePath)) return res.status(400).json({ error: 'Invalid path' });
  try {
    const r = await git(`show HEAD:${shQuote(filePath)}`);
    res.json({ content: r.code === 0 ? r.stdout : '', tracked: r.code === 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stage', async (req, res) => {
  const { path: fp } = req.body;
  if (!isSafePath(fp)) return res.status(400).json({ error: 'Invalid path' });
  try {
    const r = await git(`add -- ${shQuote(fp)}`);
    if (r.code !== 0) return res.status(500).json({ error: r.stderr });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/unstage', async (req, res) => {
  const { path: fp } = req.body;
  if (!isSafePath(fp)) return res.status(400).json({ error: 'Invalid path' });
  try {
    const r = await git(`restore --staged -- ${shQuote(fp)}`);
    if (r.code !== 0) return res.status(500).json({ error: r.stderr });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tree', async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const result = await git(showAll ? 'ls-files --cached --others -z' : 'ls-files --cached --others --exclude-standard -z');
    if (result.code !== 0) return res.status(500).json({ error: result.stderr });
    const files = result.stdout.split('\0').filter(Boolean).sort();

    const ignoredFiles = new Set(), ignoredDirs = [];
    if (showAll) {
      const ignRes = await git('status --porcelain --ignored=matching -z');
      if (ignRes.code === 0) {
        for (const entry of ignRes.stdout.split('\0').filter(Boolean)) {
          if (!entry.startsWith('!!')) continue;
          const p = entry.slice(3);
          p.endsWith('/') ? ignoredDirs.push(p.slice(0, -1)) : ignoredFiles.add(p);
        }
      }
    }
    const ignoredSet = { has: p => ignoredFiles.has(p) || ignoredDirs.some(d => p === d || p.startsWith(d + '/')) };
    const tree = treeToJSON(buildTree(files), ignoredSet);
    res.json({ tree: tree.children, files, showAll });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const MAX_FILE_BYTES = 2 * 1024 * 1024;

app.get('/api/file-content', async (req, res) => {
  const filePath = req.query.path;
  if (!isSafePath(filePath)) return res.status(400).json({ error: 'Invalid path' });
  const profile = getActive();               // capture once: size + content from same profile
  try {
    const sizeRes = await runWith(profile, `wc -c < ${shQuote(filePath)}`);
    const size = parseInt((sizeRes.stdout || '0').trim(), 10) || 0;
    if (size > MAX_FILE_BYTES) return res.json({ tooLarge: true, size, language: guessLanguage(filePath) });
    const contentRes = await runWith(profile, `cat ${shQuote(filePath)}`);
    if (contentRes.code !== 0) return res.status(500).json({ error: contentRes.stderr || 'Could not read file' });
    const content = contentRes.stdout;
    if (content.slice(0, 8000).includes(' ')) return res.json({ binary: true, language: 'plaintext' });
    res.json({ content, language: guessLanguage(filePath) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/file-content', async (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!isSafePath(filePath)) return res.status(400).json({ error: 'Invalid path' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });
  try {
    const profile = getActive();
    await writeRemoteFile(remoteAbsPath(profile, filePath), content);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Download: stream a remote file's raw bytes to the browser as an attachment.
app.get('/api/download', (req, res) => {
  const filePath = req.query.path;
  if (!isSafePath(filePath)) return res.status(400).json({ error: 'Invalid path' });
  const profile = getActive();
  if (!profile || !profile.remotePath) return res.status(400).json({ error: 'No active profile.' });

  const proc = spawn('ssh', [...sshArgs(profile), `cat ${shQuote(remoteAbsPath(profile, filePath))}`]);
  const name = path.basename(filePath).replace(/["\\\r\n]/g, '');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  proc.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  proc.stdout.pipe(res);                       // stderr (ssh warnings) is intentionally not piped into the file
  proc.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
});

// Upload: raw body (one file) written to <repo>/<path>. 409 if the target
// exists and ?overwrite=1 was not passed, so the client can confirm first.
app.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  const rel = req.query.path;
  const overwrite = req.query.overwrite === '1';
  if (!isSafePath(rel)) return res.status(400).json({ error: 'Invalid path' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty upload (folders are not supported).' });
  const profile = getActive();
  if (!profile || !profile.remotePath) return res.status(400).json({ error: 'No active profile.' });
  try {
    if (!overwrite) {
      const chk = await runWith(profile, `test -e ${shQuote(rel)} && echo EXISTS || true`);
      if ((chk.stdout || '').includes('EXISTS')) return res.status(409).json({ error: 'File already exists', exists: true });
    }
    const parent = path.posix.dirname(rel);        // create nested dirs for folder uploads
    if (parent && parent !== '.') {
      const mk = await runWith(profile, `mkdir -p ${shQuote(parent)}`);
      if (mk.code !== 0) return res.status(500).json({ error: mk.stderr || 'mkdir failed' });
    }
    await writeRemoteBuffer(profile, remoteAbsPath(profile, rel), req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Existence check for a repo-relative path (used to confirm folder overwrites).
app.get('/api/exists', async (req, res) => {
  const rel = req.query.path;
  if (!isSafePath(rel)) return res.status(400).json({ error: 'Invalid path' });
  const profile = getActive();
  if (!profile || !profile.remotePath) return res.status(400).json({ error: 'No active profile.' });
  try {
    const chk = await runWith(profile, `test -e ${shQuote(rel)} && echo EXISTS || true`);
    res.json({ exists: (chk.stdout || '').includes('EXISTS') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Download a folder as a streamed .tar.gz (tar runs on the remote).
app.get('/api/download-dir', (req, res) => {
  const dirPath = req.query.path;
  if (!isSafePath(dirPath)) return res.status(400).json({ error: 'Invalid path' });
  const profile = getActive();
  if (!profile || !profile.remotePath) return res.status(400).json({ error: 'No active profile.' });

  const repo = profile.remotePath.replace(/\/+$/, '');
  const proc = spawn('ssh', [...sshArgs(profile), `tar -czf - -C ${shQuote(repo)} ${shQuote(dirPath)}`]);
  const name = (path.basename(dirPath) || 'download').replace(/["\\\r\n]/g, '');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.tar.gz"`);
  proc.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  proc.stdout.pipe(res);                       // stderr (tar warnings) kept out of the archive stream
  proc.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
});

// Kill a terminal's tmux session on the remote (called on explicit tab close).
app.delete('/api/term-session', (req, res) => {
  const sessionId = sanitizeSessionId(req.query.session);
  if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });
  const profile = resolveProfile(req.query.profile);
  if (!profile || !profile.host) return res.status(400).json({ error: 'No profile.' });

  const name = tmuxSessionName(sessionId);
  const proc = spawn('ssh', [...sshArgs(profile), `tmux kill-session -t ${name} 2>/dev/null || true`]);
  proc.on('close', () => { if (!res.headersSent) res.json({ ok: true }); });
  proc.on('error', () => { if (!res.headersSent) res.json({ ok: true }); });   // best-effort cleanup
});

// Lightweight liveness probe: is the active profile's remote reachable over SSH
// right now? Reuses the ControlMaster so it's cheap (no git, no remotePath). A
// short ConnectTimeout makes a dropped network fail fast instead of hanging.
app.get('/api/ping', (req, res) => {
  const profile = getActive();
  if (!profile || !profile.host) return res.json({ ok: false, error: 'No active profile.' });
  // Standalone probe: bypass the ssh ControlMaster (ControlPath=none). A
  // multiplexed request can hang indefinitely on a wedged master even when the
  // remote is reachable, and ConnectTimeout only bounds a fresh connection —
  // not a session riding an existing master. This keeps the liveness check
  // honest and actually time-bounded.
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=6',
  ];
  if (profile.port && Number(profile.port) !== 22) args.push('-p', String(profile.port));
  args.push(profile.username ? `${profile.username}@${profile.host}` : profile.host, 'true');
  const proc = spawn('ssh', args);
  const finish = (ok) => { if (!res.headersSent) res.json({ ok }); };
  // Hard backstop so the route always responds even if ssh wedges for any reason.
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(false); }, 8000);
  proc.on('close', (code) => { clearTimeout(killer); finish(code === 0); });
  proc.on('error', () => { clearTimeout(killer); finish(false); });
});

// List live grv_* tmux sessions on the remote so the client can reconcile tabs.
app.get('/api/term-sessions', (req, res) => {
  const profile = resolveProfile(req.query.profile);
  if (!profile || !profile.host) return res.json({ sessions: [] });

  const proc = spawn('ssh', [...sshArgs(profile), `tmux ls -F '#{session_name}' 2>/dev/null || true`]);
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.on('close', () => {
    if (res.headersSent) return;
    const sessions = out.split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('grv_'))
      .map(s => s.slice('grv_'.length));
    res.json({ sessions });
  });
  proc.on('error', () => { if (!res.headersSent) res.json({ sessions: [] }); });
});

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

// Force a UTF-8 *character* encoding (LC_CTYPE) so tmux and TUI apps (Claude
// Code) render box-drawing / Unicode glyphs instead of substituting '_'. Many
// remotes default to a non-UTF-8 LANG (e.g. en_IN); we override only the
// encoding, leaving the language/formatting alone. Prefer C.UTF-8, else any
// installed UTF-8 locale, else literal C.UTF-8. Set before tmux so the tmux
// server, the pane's shell, and the attaching client all see UTF-8.
const LOCALE_PREFIX =
  'export LC_CTYPE="$( { locale -a 2>/dev/null | grep -ixF C.UTF-8; ' +
  'locale -a 2>/dev/null | grep -iE \'utf-?8\'; echo C.UTF-8; } | head -1)"; ';

// Attach-or-create with a stable, single-client attach:
//  - create the session detached (login shell in the repo dir) only if missing,
//    so scrollback / running processes (Claude Code) are preserved on reconnect;
//  - enable mouse mode for THIS session only (scroll-wheel scrollback) without
//    touching the user's global ~/.tmux.conf; errors on ancient tmux are ignored;
//  - attach with `-d` so any stale client is detached first — that guarantees
//    tmux sizes the window to the CURRENT viewer, so it fills the pane.
function remoteTerminalCommand({ repoPath, sessionName }) {
  const cd = repoPath ? `cd ${shQuote(repoPath)} 2>/dev/null; ` : '';
  return `${LOCALE_PREFIX}${cd}tmux has-session -t ${sessionName} 2>/dev/null || tmux new-session -d -s ${sessionName} $SHELL -l; `
       + `tmux set-option -t ${sessionName} mouse on >/dev/null 2>&1; `
       + `exec tmux attach-session -d -t ${sessionName}`;
}

function remoteFallbackCommand({ repoPath }) {
  const cd = repoPath ? `cd ${shQuote(repoPath)} 2>/dev/null; ` : '';
  return `${LOCALE_PREFIX}${cd}exec $SHELL -l`;
}

// ---------------------------------------------------------------------------
// Terminal (PTY-backed SSH over WebSocket)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/terminal' });

let _termConnSeq = 0;

wss.on('connection', async (ws, req) => {
  const cid = ++_termConnSeq;                 // short id to correlate log lines
  const url = new URL(req.url, 'http://localhost');
  const cols = parseInt(url.searchParams.get('cols'), 10) || 80;
  const rows = parseInt(url.searchParams.get('rows'), 10) || 24;

  // Bind to the profile the terminal was created under (not getActive()), so a
  // reconnect always attaches to the correct remote even after a profile switch.
  const profileName = url.searchParams.get('profile');
  const profile = (profileName && profiles[profileName]) || getActive();
  if (!profile || !profile.host) {
    slog(`term#${cid} rejected: no active profile`);
    ws.send('\r\n\x1b[31mNo active profile. Create one first.\x1b[0m\r\n');
    ws.close();
    return;
  }

  const sessionId = sanitizeSessionId(url.searchParams.get('session'));
  slog(`term#${cid} connect profile=${profileName || '(active)'} host=${profileKey(profile)} session=${sessionId || '(none)'} ${cols}x${rows}`);

  let hasTmux = false;
  try { hasTmux = sessionId ? await probeTmux(profile) : false; } catch (_) { hasTmux = false; }

  // The socket may have closed while we were probing.
  if (ws.readyState !== ws.OPEN) { slog(`term#${cid} client gone during probe`); return; }

  const repoPath = profile.remotePath || '';
  const remoteCmd = hasTmux
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
    slog(`term#${cid} pty.spawn failed: ${err.message}`);
    ws.send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }
  slog(`term#${cid} pty spawned (tmux=${hasTmux}) pid=${term.pid}`);

  let bytes = 0;
  term.onData((data) => { bytes += data.length; try { ws.send(data); } catch (_) {} });
  term.onExit(({ exitCode, signal }) => {
    slog(`term#${cid} ssh exited code=${exitCode} signal=${signal} afterBytes=${bytes}`);
    try { ws.close(); } catch (_) {}
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize') { try { term.resize(msg.cols, msg.rows); } catch (_) {} }
  });

  // Killing the local ssh only detaches the tmux client; the remote session (and
  // Claude Code) keeps running and is re-attached on the next connection.
  ws.on('close', () => { slog(`term#${cid} ws closed (afterBytes=${bytes})`); try { term.kill(); } catch (_) {} });
});

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
  app,
  shQuote,
  sanitizeSessionId,
  tmuxSessionName,
  remoteTerminalCommand,
  remoteFallbackCommand,
  fsCommand,
};
