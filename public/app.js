// ---------------------------------------------------------------------------
// Icons (inline SVG, currentColor so they follow the theme)
// ---------------------------------------------------------------------------

const ICONS = {
  chevron: '<svg class="ic ic-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.5 3.5l5 4.5-5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="ic ic-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3L7.6 4.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="currentColor" opacity="0.9"/></svg>',
  folderOpen: '<svg class="ic ic-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3L7.6 4.5h6a1 1 0 0 1 1 1v1H4.3a1 1 0 0 0-.95.68L1.5 12.8z" fill="currentColor" opacity="0.55"/><path d="M3.35 6.5A1 1 0 0 1 4.3 5.8h10.4a.7.7 0 0 1 .66.93l-1.6 5A1 1 0 0 1 12.8 12.5H1.9z" fill="currentColor" opacity="0.9"/></svg>',
  file: '<svg class="ic ic-file" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 1.75A.75.75 0 0 1 4.75 1H9.5l3.5 3.5v9.75a.75.75 0 0 1-.75.75h-7.5A.75.75 0 0 1 4 14.25z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.25 1.25v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  terminal: '<svg class="ic ic-term" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2.2 2L4 10M8 10.2h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let diffEditor = null;
let plainEditor = null;
let currentOpenPath = null;
let currentOpenKind = null;
let isDirty = false;
let allFiles = [];
let showIgnored = false;
let selectedDir = '';                // folder targeted by Ctrl+V paste ('' = repo root)
const expandedDirs = new Set();
let currentGitSelection = null;
let profileState = { profiles: {}, active: null }; // cached, no re-fetch on panel open
let currentIsMarkdown = false;
let previewMode = false;

// Multi-tab state. Each tab holds its own Monaco model(s) + view state.
let tabs = [];
let activeTabId = null;
let treeData = null; // cached tree for reveal-without-refetch
let fileStatusMap = new Map(); // path -> { letter, cls } git status for tree coloring
let dirStatusMap = new Map();  // dir path -> cls (folder contains changes)

const LETTER_CLS = { M: 'git-modified', D: 'git-deleted', A: 'git-added', R: 'git-renamed', U: 'git-untracked', '?': 'git-untracked' };

function isMarkdownPath(p) { return /\.(md|markdown|mdx)$/i.test(p || ''); }
function baseName(p) { return p.split('/').pop(); }
function explorerTabId(path) { return 'file:' + path; }
function diffTabId(path, mode) { return 'diff:' + mode + ':' + path; }
function getTab(id) { return tabs.find(t => t.id === id); }
function activeTab() { return getTab(activeTabId); }

// ---------------------------------------------------------------------------
// Theme (light / dark liquid glass)
// ---------------------------------------------------------------------------

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function monacoThemeFor(theme) { return theme === 'dark' ? 'glass-dark' : 'glass-light'; }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('grv-theme', theme);

  // Monaco (once loaded)
  if (window.monaco && monaco.editor) monaco.editor.setTheme(monacoThemeFor(theme));

  // Re-theme any open terminals live
  const tt = TERM_THEMES[theme] || TERM_THEMES.light;
  tabs.forEach(t => { if (t.kind === 'terminal' && t.term) { try { t.term.options.theme = tt; } catch (_) {} } });

  // Mermaid — affects diagrams rendered after this point
  if (window.mermaid) {
    try { mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'neutral', securityLevel: 'loose' }); } catch (_) {}
  }

  // Button shows the mode you'd switch TO
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

(function initThemeToggle() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  btn.textContent = currentTheme() === 'dark' ? '☀' : '☾';
  btn.addEventListener('click', toggleTheme);
})();

// ---------------------------------------------------------------------------
// Monaco
// ---------------------------------------------------------------------------

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  monaco.editor.defineTheme('glass-light', {
    base: 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': '#eef2fb',
      'editor.lineHighlightBackground': '#e3e9f7',
      'editorLineNumber.foreground': '#a7b0c6',
      'editorLineNumber.activeForeground': '#54607a',
      'editorGutter.background': '#eef2fb',
      'diffEditor.insertedTextBackground': '#bfe8c840',
      'diffEditor.removedTextBackground': '#efc8c440',
    },
  });
  monaco.editor.defineTheme('glass-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': '#12151f',
      'editor.lineHighlightBackground': '#1b1f2c',
      'editorLineNumber.foreground': '#495066',
      'editorLineNumber.activeForeground': '#9aa4bd',
      'editorGutter.background': '#12151f',
      'diffEditor.insertedTextBackground': '#3fb95030',
      'diffEditor.removedTextBackground': '#e0685a30',
    },
  });
  monaco.editor.setTheme(monacoThemeFor(currentTheme()));

  const fontSize = getFontSize();

  diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor-container'), {
    automaticLayout: true, renderSideBySide: true,
    // never silently collapse to inline just because a stale/zero width was
    // measured (e.g. when switching in from a terminal) — always side-by-side
    useInlineViewWhenSpaceIsLimited: false,
    minimap: { enabled: true }, originalEditable: false, fontSize,
  });

  plainEditor = monaco.editor.create(document.getElementById('plain-editor-container'), {
    automaticLayout: true, minimap: { enabled: true },
    value: '', language: 'plaintext', fontSize,
    lineDecorationsWidth: 16, // wider gutter so change bars are easy to click
    glyphMargin: false,
  });
  plainEditor.onDidChangeModelContent(() => {
    const t = activeTab();
    if (t && t.kind === 'explorer' && !t.message) { markDirty(); scheduleDecorations(); }
  });
  diffEditor.getModifiedEditor().onDidChangeModelContent(() => {
    const t = activeTab();
    if (t && t.kind === 'diff-unstaged') markDirty();
  });
  // Click a change bar in the gutter → open the file's diff at that line.
  plainEditor.onMouseDown(e => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
      const t = activeTab();
      if (t && t.kind === 'explorer' && t.hasChanges) {
        const line = e.target.position ? e.target.position.lineNumber : 1;
        selectDiff(t.path, 'unstaged', null, line);
      }
    }
  });

  initFontSizePicker(fontSize);
  initPreviewControls();
  init();
});

// Markdown + mermaid setup (globals from CDN scripts)
if (window.mermaid) {
  mermaid.initialize({ startOnLoad: false, theme: currentTheme() === 'dark' ? 'dark' : 'neutral', securityLevel: 'loose' });
}
if (window.marked) {
  marked.setOptions({ gfm: true, breaks: false });
}

// ---------------------------------------------------------------------------
// Editor font size (persisted)
// ---------------------------------------------------------------------------

function getFontSize() {
  const saved = parseInt(localStorage.getItem('grv-font-size'), 10);
  return [12, 13, 14, 16].includes(saved) ? saved : 14;
}

function applyFontSize(size) {
  diffEditor.updateOptions({ fontSize: size });
  diffEditor.getModifiedEditor().updateOptions({ fontSize: size });
  diffEditor.getOriginalEditor().updateOptions({ fontSize: size });
  plainEditor.updateOptions({ fontSize: size });
  const pv = document.getElementById('preview-content');
  if (pv) pv.style.fontSize = size + 'px';
  // terminals share the same font size
  for (const t of tabs) {
    if (t.kind === 'terminal') {
      t.term.options.fontSize = size;
      try { t.fit.fit(); } catch (_) {}
      sendResize(t.ws, t.term);
    }
  }
}

function initFontSizePicker(current) {
  const sel = document.getElementById('font-size-select');
  sel.value = String(current);
  sel.addEventListener('change', () => {
    const size = parseInt(sel.value, 10);
    localStorage.setItem('grv-font-size', String(size));
    applyFontSize(size);
  });
}

async function init() {
  await loadProfiles();   // load profiles first, then fire tree+status in parallel
  loadTree();
  loadStatus();
}

// ---------------------------------------------------------------------------
// Toast notifications (replaces alert)
// ---------------------------------------------------------------------------

function toast(msg, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3500);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.tab-btn[data-view]').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('view-explorer').style.display = view === 'explorer' ? 'flex' : 'none';
    document.getElementById('view-scm').style.display = view === 'scm' ? 'flex' : 'none';
  });
});
document.getElementById('view-scm').style.display = 'none';
document.getElementById('refresh-btn').addEventListener('click', () => { loadStatus(); loadTree(); });
document.querySelectorAll('.section-twisty').forEach(el => { el.innerHTML = ICONS.chevron; });
document.querySelectorAll('.section-title').forEach(el => {
  el.addEventListener('click', () => el.parentElement.classList.toggle('collapsed'));
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function setStatus(msg, kind = '') {
  const el = document.getElementById('sb-status');
  el.textContent = msg;
  el.className = 'sb-item sb-conn' + (kind ? ' ' + kind : '');
}

function updateStatusBar() {
  document.getElementById('sb-profile-name').textContent = profileState.active || 'No profile';
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

document.getElementById('profile-btn').addEventListener('click', openProfilesOverlay);
document.getElementById('pp-close').addEventListener('click', closeProfilesOverlay);
document.getElementById('profiles-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('profiles-overlay')) closeProfilesOverlay();
});

function openProfilesOverlay() {
  renderProfileList(); // render from cached state, no fetch
  document.getElementById('profiles-overlay').style.display = 'flex';
}
function closeProfilesOverlay() {
  document.getElementById('profiles-overlay').style.display = 'none';
  document.getElementById('pp-form').style.display = 'none';
  document.getElementById('pp-new-btn').style.display = 'block';
}

async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles');
    const data = await res.json();
    profileState = data;
    updateStatusBar();
    renderProfileList();
    if (!data.active) openProfilesOverlay();
  } catch (e) { /* ignore */ }
}

function renderProfileList() {
  const { profiles, active } = profileState;
  const list = document.getElementById('pp-list');
  list.innerHTML = '';
  const names = Object.keys(profiles);
  if (names.length === 0) {
    list.innerHTML = '<div class="pp-empty">No profiles yet.</div>';
    return;
  }
  for (const name of names) {
    const p = profiles[name];
    const isActive = name === active;
    const item = document.createElement('div');
    item.className = 'pp-item' + (isActive ? ' active' : '');

    const dot = document.createElement('div');
    dot.className = isActive ? 'pp-dot' : 'pp-dot-empty';
    item.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'pp-info';
    info.innerHTML = `<div class="pp-name">${name}</div>
      <div class="pp-detail">${p.username ? p.username + '@' : ''}${p.host} · ${p.remotePath}</div>`;
    info.addEventListener('click', () => activateProfile(name));
    item.appendChild(info);

    const del = document.createElement('button');
    del.className = 'pp-del';
    del.textContent = '✕';
    del.title = 'Delete';
    del.addEventListener('click', e => { e.stopPropagation(); deleteProfile(name); });
    item.appendChild(del);

    list.appendChild(item);
  }
}

document.getElementById('pp-new-btn').addEventListener('click', () => {
  document.getElementById('pp-form').style.display = 'block';
  document.getElementById('pp-new-btn').style.display = 'none';
  ['pf-name','pf-host','pf-username','pf-remotepath'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pf-name').focus();
});

document.getElementById('pf-cancel').addEventListener('click', () => {
  document.getElementById('pp-form').style.display = 'none';
  document.getElementById('pp-new-btn').style.display = 'block';
});

document.getElementById('pf-save').addEventListener('click', async () => {
  const name       = document.getElementById('pf-name').value.trim();
  const host       = document.getElementById('pf-host').value.trim();
  const username   = document.getElementById('pf-username').value.trim();
  const remotePath = document.getElementById('pf-remotepath').value.trim();
  if (!name || !host || !remotePath) { toast('Name, host, and remote path are required.'); return; }
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, host, username, remotePath }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error); return; }
    profileState.profiles[name] = { host, username, remotePath };
    document.getElementById('pp-form').style.display = 'none';
    document.getElementById('pp-new-btn').style.display = 'block';
    renderProfileList();
  } catch (err) { toast(err.message); }
});

// Close all file/diff tabs (they belong to the outgoing profile — keeping them
// open risks saving to a same-named file on the WRONG host after a switch, C3).
// Terminals keep their own independent SSH connection, so they're left alone.
// Returns false if the user cancelled because of unsaved changes.
function closeProfileScopedTabs(force) {
  const scoped = tabs.filter(t => t.kind === 'explorer' || t.kind === 'diff-staged' || t.kind === 'diff-unstaged');
  if (!force) {
    const dirty = scoped.filter(t => t.dirty).length;
    if (dirty && !confirm(`Switching profiles will discard unsaved changes in ${dirty} open file(s). Continue?`)) return false;
  }
  for (const t of scoped.slice()) { t.dirty = false; closeTab(t.id); }
  return true;
}

async function activateProfile(name) {
  if (name === profileState.active) { closeProfilesOverlay(); return; }
  if (!closeProfileScopedTabs(false)) return;   // user kept unsaved changes → abort switch
  try {
    await fetch(`/api/profiles/${encodeURIComponent(name)}/activate`, { method: 'POST' });
    profileState.active = name;
    updateStatusBar();
    renderProfileList();
    closeProfilesOverlay();
    setStatus('Connecting…');
    loadTree();
    loadStatus();
  } catch (err) { toast(err.message); }
}

async function deleteProfile(name) {
  if (!confirm(`Delete profile "${name}"?`)) return;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) { toast(data.error); return; }
    const wasActive = profileState.active === name;
    delete profileState.profiles[name];
    if (wasActive) {
      profileState.active = Object.keys(profileState.profiles)[0] || null;
      closeProfileScopedTabs(true);            // files of the deleted profile are orphaned
    }
    updateStatusBar();
    renderProfileList();
    if (profileState.active) { loadTree(); loadStatus(); }
  } catch (err) { toast(err.message); }
}

// ---------------------------------------------------------------------------
// Explorer: file tree
// ---------------------------------------------------------------------------

document.getElementById('show-ignored').addEventListener('change', e => { showIgnored = e.target.checked; loadTree(); });

async function loadTree() {
  try {
    const res = await fetch(`/api/tree${showIgnored ? '?all=1' : ''}`);
    if (!res.ok) { setStatus('SSH error', 'error'); return; }
    const data = await res.json();
    if (data.error) { setStatus(data.error, 'error'); return; }
    allFiles = data.files;
    treeData = data.tree;
    renderTree();
    setStatus('Connected', 'ok');
  } catch (err) { setStatus('Connection failed', 'error'); }
}

function renderTree() {
  const container = document.getElementById('tree-container');
  container.innerHTML = '';
  if (treeData) renderNodes(treeData, container, 0, '');
}

function treeRowByPath(path) {
  return document.querySelector(`#tree-container .tree-file[data-path="${CSS.escape(path)}"]`);
}

// Expand every ancestor folder of `path`, then select + scroll to the file —
// like VS Code revealing a file in the Explorer.
function revealInTree(path) {
  // make sure the Explorer view + tree are visible
  document.querySelector('.tab-btn[data-view="explorer"]').click();
  const search = document.getElementById('file-search');
  if (search.value) {
    search.value = '';
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('tree-container').style.display = 'block';
  }

  let row = treeRowByPath(path);
  if (!row) {
    const parts = path.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      expandedDirs.add(acc);
    }
    renderTree();
    row = treeRowByPath(path);
  }
  if (row) {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
  }
}

// Lazy tree: a folder's children are only built into the DOM the first time
// it is expanded. Without this, a large repo (100k+ files) would create every
// node up-front (just hidden), which freezes the browser.
function renderNodes(nodes, container, depth, parentPath) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    if (node.type === 'dir') {
      const row = document.createElement('div');
      row.className = 'tree-row tree-dir' + (node.ignored ? ' ignored' : '');
      row.style.paddingLeft = `${6 + depth * 14}px`;
      row.dataset.path = fullPath;

      const isExpanded = expandedDirs.has(fullPath);
      const twist = document.createElement('span');
      twist.className = 'twisty' + (isExpanded ? ' open' : '');
      twist.innerHTML = ICONS.chevron;

      const folder = document.createElement('span');
      folder.className = 'row-icon folder-icon';
      folder.innerHTML = isExpanded ? ICONS.folderOpen : ICONS.folder;

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = node.name;
      const dcls = dirStatusMap.get(fullPath);
      if (dcls) name.classList.add(dcls);
      row.appendChild(twist);
      row.appendChild(folder);
      row.appendChild(name);
      const dirDl = document.createElement('button');
      dirDl.className = 'row-download';
      dirDl.title = 'Download folder (.tar.gz)';
      dirDl.innerHTML = ICONS.download;
      dirDl.addEventListener('click', (e) => { e.stopPropagation(); downloadDir(fullPath); });
      row.appendChild(dirDl);
      frag.appendChild(row);

      const childContainer = document.createElement('div');
      childContainer.style.display = isExpanded ? 'block' : 'none';
      childContainer.dataset.rendered = 'false';
      frag.appendChild(childContainer);

      const renderChildren = () => {
        if (childContainer.dataset.rendered === 'true') return;
        renderNodes(node.children, childContainer, depth + 1, fullPath);
        childContainer.dataset.rendered = 'true';
      };
      if (isExpanded) renderChildren();

      const openDir = () => {
        if (childContainer.style.display !== 'none') return;
        renderChildren();
        childContainer.style.display = 'block';
        twist.classList.add('open');
        folder.innerHTML = ICONS.folderOpen;
        expandedDirs.add(fullPath);
      };

      row.addEventListener('click', () => {
        selectDir(fullPath, row);            // remember target for Ctrl+V paste
        const opening = childContainer.style.display === 'none';
        if (opening) renderChildren();
        childContainer.style.display = opening ? 'block' : 'none';
        twist.classList.toggle('open', opening);
        folder.innerHTML = opening ? ICONS.folderOpen : ICONS.folder;
        if (opening) expandedDirs.add(fullPath);
        else expandedDirs.delete(fullPath);
      });

      if (fullPath === selectedDir) row.classList.add('dir-selected');
      attachDropZone(row, fullPath, openDir);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-row tree-file' + (node.ignored ? ' ignored' : '');
      row.style.paddingLeft = `${6 + depth * 14}px`;
      row.dataset.path = node.path;
      if (currentOpenKind === 'explorer' && currentOpenPath === node.path) row.classList.add('selected');

      const twistSpacer = document.createElement('span');
      twistSpacer.className = 'twisty-spacer';

      const icon = document.createElement('span');
      icon.className = 'row-icon file-icon-svg';
      icon.innerHTML = ICONS.file;

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = node.name;
      const st = fileStatusMap.get(node.path);
      if (st) name.classList.add(st.cls);
      row.appendChild(twistSpacer);
      row.appendChild(icon);
      row.appendChild(name);
      if (st) {
        const badge = document.createElement('span');
        badge.className = 'tree-status ' + st.cls;
        badge.textContent = st.letter;
        row.appendChild(badge);
      }
      const dl = document.createElement('button');
      dl.className = 'row-download';
      dl.title = 'Download';
      dl.innerHTML = ICONS.download;
      dl.addEventListener('click', (e) => { e.stopPropagation(); downloadFile(node.path); });
      row.appendChild(dl);
      row.addEventListener('click', () => openFile(node.path));
      frag.appendChild(row);
    }
  }
  container.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Upload / download (drag-drop, paste, per-file download)
// ---------------------------------------------------------------------------

// Mark a folder as the paste target and highlight it.
function selectDir(fullPath, row) {
  selectedDir = fullPath;
  document.querySelectorAll('#tree-container .dir-selected').forEach(r => r.classList.remove('dir-selected'));
  if (row) row.classList.add('dir-selected');
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function downloadFile(p) {
  triggerDownload(`/api/download?path=${encodeURIComponent(p)}`, p.split('/').pop());
}
function downloadDir(p) {
  triggerDownload(`/api/download-dir?path=${encodeURIComponent(p)}`, (p.split('/').pop() || 'download') + '.tar.gz');
}

// Low-level: PUT one File/Blob to a repo-relative path. Returns
// {ok} | {conflict} | {error}. Parent dirs are created server-side.
async function uploadPath(body, rel, overwrite) {
  let url = `/api/upload?path=${encodeURIComponent(rel)}`;
  if (overwrite) url += '&overwrite=1';
  const res = await fetch(url, { method: 'POST', body });
  if (res.status === 409) return { conflict: true };
  if (!res.ok) {
    let msg = 'Upload failed';
    try { msg = (await res.json()).error || msg; } catch (_) {}
    return { error: msg };
  }
  return { ok: true };
}

async function checkExists(rel) {
  try {
    const res = await fetch(`/api/exists?path=${encodeURIComponent(rel)}`);
    return res.ok ? (await res.json()).exists : false;
  } catch (_) { return false; }
}

// Upload one loose file to <folder>/<name>, confirming before overwrite.
async function uploadOne(fileOrBlob, folder, name) {
  const rel = folder ? `${folder}/${name}` : name;
  let r = await uploadPath(fileOrBlob, rel, false);
  if (r.conflict) {
    if (!confirm(`"${name}" already exists in ${folder || 'the repo root'}. Overwrite?`)) return false;
    r = await uploadPath(fileOrBlob, rel, true);
  }
  if (r.error) { toast(`${name}: ${r.error}`); return false; }
  return !!r.ok;
}

// Loose-file uploads (used by paste): each confirms its own overwrite.
async function uploadFiles(files, folder) {
  if (!files.length) return;
  let ok = 0;
  for (const f of files) if (await uploadOne(f, folder, f.name)) ok++;
  if (ok) {
    toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''} to ${folder || 'repo root'}`, 'success');
    await loadTree();
    await loadStatus();
  }
}

// --- Recursive folder drops ------------------------------------------------

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

// Depth-first walk of a dropped FileSystemEntry, collecting {file, relPath}.
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relPath: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {                                   // readEntries returns at most ~100 per call
      batch = await readEntries(reader);
      for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
    } while (batch.length);
  }
}

// Gather dropped items into {file, relPath}[]. Entries must be pulled from the
// DataTransfer synchronously (before any await), or the browser clears them.
async function collectDropped(dt) {
  const items = dt.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = [];
    for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) entries.push(e); }
    const out = [];
    for (const e of entries) await walkEntry(e, '', out);
    return out;
  }
  return Array.from(dt.files || []).map(f => ({ file: f, relPath: f.name }));   // no entry API: flat only
}

// Upload a mixed set of dropped files/folders under baseFolder. Folders get a
// single overwrite confirm each; loose files use the per-file confirm.
async function uploadDropped(dropList, baseFolder) {
  if (!dropList.length) return;

  const topFolders = new Set();
  for (const d of dropList) {
    const slash = d.relPath.indexOf('/');
    if (slash > 0) topFolders.add(d.relPath.slice(0, slash));
  }
  const folderDecision = {};               // top folder -> upload? (false = skip)
  for (const top of topFolders) {
    const rel = baseFolder ? `${baseFolder}/${top}` : top;
    folderDecision[top] = !(await checkExists(rel)) ||
      confirm(`Folder "${top}" already exists in ${baseFolder || 'the repo root'}. Upload anyway and overwrite matching files?`);
  }

  let ok = 0, failed = 0;
  for (const d of dropList) {
    const slash = d.relPath.indexOf('/');
    const top = slash > 0 ? d.relPath.slice(0, slash) : null;
    if (top) {
      if (folderDecision[top] === false) continue;
      const rel = baseFolder ? `${baseFolder}/${d.relPath}` : d.relPath;
      const r = await uploadPath(d.file, rel, true);
      if (r.ok) ok++; else { failed++; if (r.error) toast(`${d.relPath}: ${r.error}`); }
    } else {
      if (await uploadOne(d.file, baseFolder, d.file.name)) ok++; else failed++;
    }
  }
  if (ok) {
    toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''} to ${baseFolder || 'repo root'}${failed ? ` (${failed} failed)` : ''}`, 'success');
    await loadTree();
    await loadStatus();
  } else if (failed) {
    toast(`Upload failed (${failed} file${failed > 1 ? 's' : ''})`);
  }
}

// Wire drag-drop onto a folder row: highlight while hovering, auto-expand a
// collapsed folder after a short hover (VS Code behaviour), upload on drop.
let dragExpandTimer = null, dragExpandPath = null;
function clearDragExpand() { clearTimeout(dragExpandTimer); dragExpandTimer = null; dragExpandPath = null; }
function setDropTarget(row) {
  document.querySelectorAll('#tree-container .drop-target').forEach(r => r.classList.remove('drop-target'));
  document.getElementById('tree-container').classList.remove('root-drop');
  if (row) row.classList.add('drop-target');
}

function attachDropZone(row, fullPath, openDir) {
  row.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(row);
    if (dragExpandPath !== fullPath) {
      clearDragExpand();
      dragExpandPath = fullPath;
      dragExpandTimer = setTimeout(() => { openDir(); dragExpandTimer = null; }, 650);
    }
  });
  row.addEventListener('dragleave', (e) => {
    if (row.contains(e.relatedTarget)) return;   // ignore moves onto children
    row.classList.remove('drop-target');
    if (dragExpandPath === fullPath) clearDragExpand();
  });
  row.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    clearDragExpand();
    const dropped = await collectDropped(e.dataTransfer);
    await uploadDropped(dropped, fullPath);
  });
}

// Root-level drops (empty tree area) + Ctrl/Cmd+V paste, wired once.
function initUploadTargets() {
  const tree = document.getElementById('tree-container');

  tree.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(null);
    tree.classList.add('root-drop');
    clearDragExpand();
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) tree.classList.remove('root-drop'); });
  tree.addEventListener('drop', async (e) => {          // only fires if a folder row didn't handle it
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    tree.classList.remove('root-drop');
    const dropped = await collectDropped(e.dataTransfer);
    await uploadDropped(dropped, '');                    // '' = repo root
  });

  // Stop the browser from navigating away when a file is dropped outside a zone.
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });

  document.addEventListener('paste', async (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;                // let text paste through
    const ae = document.activeElement;
    if (ae && (ae.closest('#terminal-container') || ae.closest('.monaco-editor') ||
               ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    e.preventDefault();
    const list = [];
    for (const f of files) {
      let name = f.name;
      if (!name) {                                      // clipboard image (screenshot) has no filename
        const ext = ((f.type.split('/')[1]) || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        name = `pasted-${Date.now()}.${ext}`;
      }
      list.push(new File([f], name, { type: f.type }));
    }
    await uploadFiles(list, selectedDir);
  });
}
initUploadTargets();

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function fuzzyScore(query, str) {
  query = query.toLowerCase(); str = str.toLowerCase();
  let qi = 0, score = 0, last = -1;
  for (let i = 0; i < str.length && qi < query.length; i++) {
    if (str[i] === query[qi]) { score += last === i - 1 ? 2 : 1; last = i; qi++; }
  }
  return qi === query.length ? score : -1;
}

document.getElementById('file-search').addEventListener('input', e => {
  const query = e.target.value.trim();
  const resultsEl = document.getElementById('search-results');
  const treeEl = document.getElementById('tree-container');
  if (!query) { resultsEl.style.display = 'none'; treeEl.style.display = 'block'; return; }

  const scored = allFiles
    .map(f => ({ path: f, score: fuzzyScore(query, f) }))
    .filter(f => f.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  resultsEl.innerHTML = '';
  for (const { path: p } of scored) {
    const row = document.createElement('div');
    row.className = 'tree-row search-result';
    row.style.paddingLeft = '8px';
    const icon = document.createElement('span');
    icon.className = 'row-icon file-icon-svg';
    icon.innerHTML = ICONS.file;
    row.appendChild(icon);
    const parts = p.split('/');
    const base = parts.pop();
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = base;
    if (parts.length) {
      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = ' ' + parts.join('/');
      name.appendChild(dir);
    }
    row.appendChild(name);
    row.addEventListener('click', () => openFile(p));
    resultsEl.appendChild(row);
  }
  resultsEl.style.display = 'block';
  treeEl.style.display = 'none';
});

// ---------------------------------------------------------------------------
// File open / save
// ---------------------------------------------------------------------------

// Monotonic token for "what the user most recently asked to open". A slow
// fetch that resolves after a newer open must NOT steal focus (C1).
let openSeq = 0;

// Open a file in a tab (reusing an existing tab if already open) and reveal it.
async function openFile(filePath) {
  revealInTree(filePath);
  const id = explorerTabId(filePath);
  if (getTab(id)) { activateTab(id); return; }
  const seq = ++openSeq;
  try {
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) { toast(data.error); return; }

    // A concurrent open of the same file may have created the tab while we
    // awaited — reuse it instead of pushing a duplicate (C2).
    let tab = getTab(id);
    if (!tab) {
      tab = {
        id, kind: 'explorer', path: filePath, label: baseName(filePath),
        isMarkdown: isMarkdownPath(filePath), previewMode: false,
        dirty: false, viewState: null, model: null, message: null,
        language: data.language || 'plaintext',
        headContent: undefined, decoIds: [], hasChanges: false,
      };
      if (data.tooLarge)   tab.message = `File too large to preview (${Math.round(data.size / 1024)} KB).`;
      else if (data.binary) tab.message = 'Binary file — no text preview.';
      else tab.model = monaco.editor.createModel(data.content, data.language);
      tabs.push(tab);
      renderTabs();
    }
    // Only take over the editor if this is still the latest open request (C1).
    if (seq === openSeq) activateTab(id);
  } catch (err) { toast('Could not load file: ' + err.message); }
}

async function reloadExplorerTab(tab) {
  const res = await fetch(`/api/file-content?path=${encodeURIComponent(tab.path)}`);
  const data = await res.json();
  if (data.error) { toast(data.error); return; }
  if (!getTab(tab.id)) return;               // tab was closed mid-reload (I1)
  tab.model?.dispose();
  tab.model = null;
  tab.message = null;
  if (data.tooLarge)   tab.message = `File too large to preview (${Math.round(data.size / 1024)} KB).`;
  else if (data.binary) tab.message = 'Binary file — no text preview.';
  else tab.model = monaco.editor.createModel(data.content, data.language);
  tab.dirty = false;
  tab.headContent = undefined; // HEAD may have moved; refetch
  if (tab.id === activeTabId) activateTab(tab.id);
}

async function reloadDiffTab(tab) {
  const mode = tab.kind === 'diff-staged' ? 'staged' : 'unstaged';
  const res = await fetch(`/api/file-diff?path=${encodeURIComponent(tab.path)}&mode=${mode}`);
  const data = await res.json();
  if (data.error) { toast(data.error); return; }
  if (!getTab(tab.id)) return;               // tab was closed mid-reload (I1)
  tab.origModel?.dispose(); tab.modModel?.dispose();
  tab.origModel = monaco.editor.createModel(data.original, data.language);
  tab.modModel  = monaco.editor.createModel(data.modified,  data.language);
  tab.dirty = false;
  if (tab.id === activeTabId) activateTab(tab.id);
}

// ---------------------------------------------------------------------------
// Dirty-diff gutter (VS Code-style changed-line indicators vs HEAD)
// ---------------------------------------------------------------------------

let decoTimer = null;

async function loadHeadForTab(tab) {
  try {
    const res = await fetch(`/api/file-head?path=${encodeURIComponent(tab.path)}`);
    const data = await res.json();
    tab.headContent = (data && data.tracked) ? data.content : null;
  } catch { tab.headContent = null; }
  if (tab.id === activeTabId) updateDecorations();
}

function ensureDecorations(tab) {
  if (tab.message) return;
  if (tab.headContent === undefined) loadHeadForTab(tab); // async, will apply when done
  else updateDecorations();
}

function scheduleDecorations() {
  clearTimeout(decoTimer);
  decoTimer = setTimeout(updateDecorations, 250);
}

function updateDecorations() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'explorer' || !tab.model) return;
  if (tab.headContent == null) {
    tab.decoIds = plainEditor.deltaDecorations(tab.decoIds || [], []);
    tab.hasChanges = false;
    return;
  }
  const ops = diffLines(tab.headContent.split('\n'), tab.model.getValue().split('\n'));
  const blocks = opsToDecorations(ops);
  tab.hasChanges = blocks.length > 0;
  const DIRTY_COLORS = { added: '#3D7A3D', modified: '#3A6E8F', deleted: '#B04030' };
  const decos = blocks.map(b => ({
    range: new monaco.Range(b.from, 1, b.to, 1),
    options: {
      linesDecorationsClassName: 'dirty-gutter dirty-' + b.type,
      overviewRuler: { color: DIRTY_COLORS[b.type], position: monaco.editor.OverviewRulerLane.Left },
      minimap: { color: DIRTY_COLORS[b.type], position: monaco.editor.MinimapPosition.Gutter },
    },
  }));
  tab.decoIds = plainEditor.deltaDecorations(tab.decoIds || [], decos);
}

// Line diff → array of 'same' | 'add' | 'del' ops in order.
// Trims the common prefix/suffix, then runs a Myers O(ND) diff on the middle
// (hashing lines to ints so comparisons are fast). This stays cheap on big
// files with small real changes, instead of the old O(n·m) LCS.
function diffLines(a, b) {
  const ops = [];
  const n = a.length, m = b.length;
  let s = 0;
  while (s < n && s < m && a[s] === b[s]) { ops.push('same'); s++; }
  let ea = n, eb = m, suffix = 0;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { suffix++; ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  for (const o of myersOps(A, B)) ops.push(o);
  for (let k = 0; k < suffix; k++) ops.push('same');
  return ops;
}

function myersOps(A, B) {
  const N = A.length, M = B.length;
  if (N === 0) return Array(M).fill('add');
  if (M === 0) return Array(N).fill('del');

  // hash lines to ints for O(1) comparison
  const map = new Map();
  const enc = (str) => { let v = map.get(str); if (v === undefined) { v = map.size; map.set(str, v); } return v; };
  const AA = new Int32Array(N), BB = new Int32Array(M);
  for (let i = 0; i < N; i++) AA[i] = enc(A[i]);
  for (let j = 0; j < M; j++) BB[j] = enc(B[j]);

  const capD = Math.min(N + M, 8000); // very rarely hit; bounds pathological cases
  const size = 2 * capD + 1;
  const offset = capD;
  let V = new Int32Array(size);
  const trace = [];
  let found = -1;

  for (let d = 0; d <= capD; d++) {
    trace.push(V.slice());
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) x = V[offset + k + 1];
      else x = V[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && AA[x] === BB[y]) { x++; y++; }
      V[offset + k] = x;
      if (x >= N && y >= M) { found = d; done = true; break; }
    }
    if (done) break;
  }

  // pathological fallback (diff larger than capD): mark all as changed
  if (found < 0) return [...Array(N).fill('del'), ...Array(M).fill('add')];

  // backtrack the edit path
  const ops = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const Vp = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && Vp[offset + k - 1] < Vp[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = Vp[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('same'); x--; y--; }
    if (x === prevX) { ops.push('add'); y--; }
    else { ops.push('del'); x--; }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push('same'); x--; y--; }
  while (y > 0) { ops.push('add'); y--; }
  while (x > 0) { ops.push('del'); x--; }
  ops.reverse();
  return ops;
}

// Fold ops into gutter blocks over NEW line numbers.
function opsToDecorations(ops) {
  const out = [];
  let newLine = 0, i = 0;
  while (i < ops.length) {
    if (ops[i] === 'same') { newLine++; i++; continue; }
    let adds = 0, dels = 0;
    const start = newLine + 1;
    while (i < ops.length && ops[i] !== 'same') {
      if (ops[i] === 'add') { adds++; newLine++; } else dels++;
      i++;
    }
    if (adds > 0) out.push({ from: start, to: start + adds - 1, type: dels > 0 ? 'modified' : 'added' });
    else if (dels > 0) out.push({ from: Math.max(1, newLine), to: Math.max(1, newLine), type: 'deleted' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminals (xterm.js over WebSocket to a PTY-backed ssh on the remote)
// ---------------------------------------------------------------------------

let termCounter = 0;

const TERM_THEMES = {
  light: {
    background: '#eef2fb', foreground: '#1b2333',
    cursor: '#0071e3', cursorAccent: '#eef2fb', selectionBackground: '#cfe0f7',
    black: '#1b2333', red: '#c0492f', green: '#2f8a46', yellow: '#b5771a',
    blue: '#0071e3', magenta: '#6e56cf', cyan: '#2f8a9e', white: '#c3ccdf',
    brightBlack: '#54607a', brightRed: '#d0604a', brightGreen: '#3fa159', brightYellow: '#c98a26',
    brightBlue: '#3a8bff', brightMagenta: '#8a72e0', brightCyan: '#3aa1b5', brightWhite: '#1b2333',
  },
  dark: {
    background: '#12151f', foreground: '#eef1f8',
    cursor: '#4a9bff', cursorAccent: '#12151f', selectionBackground: '#2c3550',
    black: '#20242f', red: '#e0685a', green: '#57b96b', yellow: '#d9a13a',
    blue: '#4a9bff', magenta: '#a78bfa', cyan: '#4fc4d6', white: '#c3ccdf',
    brightBlack: '#6c7690', brightRed: '#ec8072', brightGreen: '#70ca82', brightYellow: '#e8b45a',
    brightBlue: '#6fb0ff', brightMagenta: '#bda3ff', brightCyan: '#6fd6e6', brightWhite: '#eef1f8',
  },
};
const termTheme = () => TERM_THEMES[currentTheme()] || TERM_THEMES.light;
const TERM_FONT = '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace';

function newTerminal() {
  if (!window.Terminal) { toast('Terminal library not loaded'); return; }
  if (!profileState.active) { toast('Create/activate a profile first'); return; }

  const n = ++termCounter;
  const id = 'term:' + n;
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

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/terminal?cols=${term.cols}&rows=${term.rows}`);
  ws.onopen = () => { try { fit.fit(); } catch (_) {} sendResize(ws, term); };
  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = () => term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
  ws.onerror = () => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

  term.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

  const tab = { id, kind: 'terminal', label: 'Terminal ' + n, dirty: false, term, fit, ws, el };
  tabs.push(tab);
  activateTab(id);
}

function sendResize(ws, term) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

function fitActiveTerminal() {
  const t = activeTab();
  if (t && t.kind === 'terminal') {
    try { t.fit.fit(); } catch (_) {}
    sendResize(t.ws, t.term);
    t.term.focus();
  }
}

// ---------------------------------------------------------------------------
// Tab manager
// ---------------------------------------------------------------------------

function renderTabs() {
  const strip = document.getElementById('tab-strip');
  strip.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.title = tab.path || tab.label;

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.innerHTML = tab.kind === 'terminal' ? ICONS.terminal : ICONS.file;

    const label = document.createElement('span');
    label.className = 'tab-label';
    const suffix = tab.kind === 'diff-staged' ? ' (staged)' : tab.kind === 'diff-unstaged' ? ' (diff)' : '';
    label.textContent = tab.label + suffix;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Close';
    close.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });

    el.addEventListener('click', () => activateTab(tab.id));
    el.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    el.append(icon, label, close);
    strip.appendChild(el);
  }
}

function saveTabViewState(tab) {
  try {
    if (tab.kind === 'explorer') {
      if (!tab.previewMode && !tab.message) tab.viewState = plainEditor.saveViewState();
    } else {
      tab.viewState = diffEditor.saveViewState();
    }
  } catch (_) {}
}

function activateTab(id) {
  const prev = activeTab();
  if (prev && prev.id !== id) saveTabViewState(prev);

  const tab = getTab(id);
  if (!tab) return;
  activeTabId = id;

  document.getElementById('editor-header').style.display = 'flex';

  // Terminal tabs are handled separately (no editor models / git state).
  if (tab.kind === 'terminal') {
    currentOpenPath = null; currentOpenKind = 'terminal';
    currentGitSelection = null; isDirty = false;
    document.getElementById('reload-btn').style.display = 'none';
    document.getElementById('preview-btn').style.display = 'none';
    document.getElementById('save-btn').style.display = 'none';
    document.getElementById('readonly-note').style.display = 'none';
    showEditorArea('terminal');
    for (const el of document.querySelectorAll('.term-instance')) el.style.display = 'none';
    tab.el.style.display = 'block';
    setTimeout(() => fitActiveTerminal(), 30);
    renderTabs();
    document.querySelectorAll('.tree-row.selected, .file-row.selected').forEach(r => r.classList.remove('selected'));
    return;
  }

  // globals mirror the active tab (used by save/preview/reload/dirty)
  currentOpenPath = tab.path;
  currentOpenKind = tab.kind;
  currentIsMarkdown = tab.isMarkdown;
  previewMode = tab.previewMode;
  isDirty = tab.dirty;
  currentGitSelection = tab.kind === 'explorer'
    ? null
    : { path: tab.path, mode: tab.kind === 'diff-staged' ? 'staged' : 'unstaged' };

  document.getElementById('reload-btn').style.display = 'inline-flex';

  if (tab.kind === 'explorer') {
    const pv = document.getElementById('preview-btn');
    pv.style.display = tab.isMarkdown ? 'inline-flex' : 'none';
    pv.classList.toggle('active', tab.previewMode);
    pv.textContent = tab.previewMode ? 'Editor' : 'Preview';
    document.getElementById('save-btn').style.display = tab.message ? 'none' : 'inline-block';
    document.getElementById('readonly-note').style.display = 'none';

    if (tab.message) {
      showPlainMessage(tab.message);
    } else if (tab.previewMode) {
      plainEditor.setModel(tab.model);
      showEditorArea('preview');
      renderPreview();
    } else {
      // Show the container BEFORE setting the model so Monaco lays out against
      // a real (non-zero, visible) element — otherwise it can throw on resize.
      showEditorArea('plain');
      plainEditor.setModel(tab.model);
      plainEditor.updateOptions({ readOnly: false });
      relayout(plainEditor);
      if (tab.viewState) plainEditor.restoreViewState(tab.viewState);
      ensureDecorations(tab);
    }
  } else {
    document.getElementById('preview-btn').style.display = 'none';
    const editable = tab.kind === 'diff-unstaged';
    document.getElementById('save-btn').style.display = editable ? 'inline-block' : 'none';
    document.getElementById('readonly-note').style.display = editable ? 'none' : 'inline';
    // Container must be visible before setModel/layout or the diff editor's
    // view crashes with "coordinatesConverter" null on the next resize.
    showEditorArea('diff');
    diffEditor.setModel({ original: tab.origModel, modified: tab.modModel });
    diffEditor.getModifiedEditor().updateOptions({ readOnly: !editable });
    relayout(diffEditor);
    if (tab.viewState) diffEditor.restoreViewState(tab.viewState);
  }

  renderTabs();
  syncTreeSelection(tab);
}

// Lay out a Monaco editor now and again after the browser has painted the
// just-shown container, so it never keeps a stale/zero size (which makes the
// diff collapse to inline and the scrollbar/minimap mis-render).
function relayout(editor) {
  try { editor.layout(); } catch (_) {}
  requestAnimationFrame(() => {
    try { editor.layout(); } catch (_) {}
  });
}

function syncTreeSelection(tab) {
  document.querySelectorAll('.tree-row.selected, .file-row.selected').forEach(r => r.classList.remove('selected'));
  if (tab.kind === 'explorer') {
    const row = treeRowByPath(tab.path);
    if (row) row.classList.add('selected');
  }
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.dirty && !confirm(`"${tab.label}" has unsaved changes. Close anyway?`)) return;
  tab.disposed = true;
  tab.model?.dispose(); tab.origModel?.dispose(); tab.modModel?.dispose();
  tab.model = tab.origModel = tab.modModel = null;   // avoid double-dispose (I1)
  if (tab.kind === 'terminal') {
    // Detach WS handlers BEFORE closing/disposing so a late onclose/onerror/
    // onmessage/onopen can't call term.write() on a disposed xterm (C4).
    if (tab.ws) { tab.ws.onopen = tab.ws.onmessage = tab.ws.onclose = tab.ws.onerror = null; }
    try { tab.ws.close(); } catch (_) {}
    try { tab.term.dispose(); } catch (_) {}
    tab.el?.remove();
  }
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    activeTabId = null;
    const next = tabs[idx] || tabs[idx - 1];
    if (next) activateTab(next.id);
    else showEmptyState();
  } else {
    renderTabs();
  }
}

function showEmptyState() {
  activeTabId = null;
  currentOpenPath = null;
  currentOpenKind = null;
  document.getElementById('editor-header').style.display = 'none';
  for (const id of ['diff-editor-container', 'plain-editor-container', 'preview-container', 'plain-message', 'terminal-container']) {
    document.getElementById(id).style.display = 'none';
  }
  document.getElementById('empty-state').style.display = 'flex';
  renderTabs();
}

function showEditorArea(which) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('diff-editor-container').style.display = which === 'diff' ? 'block' : 'none';
  document.getElementById('plain-editor-container').style.display = which === 'plain' ? 'block' : 'none';
  document.getElementById('preview-container').style.display = which === 'preview' ? 'flex' : 'none';
  document.getElementById('terminal-container').style.display = which === 'terminal' ? 'block' : 'none';
  document.getElementById('plain-message').style.display = which === 'msg' ? 'flex' : 'none';
}

function showPlainMessage(text) {
  showEditorArea('msg');
  document.getElementById('plain-message').textContent = text;
  document.getElementById('save-btn').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Markdown preview + reload + adjustable width
// ---------------------------------------------------------------------------

function initPreviewControls() {
  document.getElementById('reload-btn').addEventListener('click', reloadCurrentFile);
  document.getElementById('preview-btn').addEventListener('click', togglePreview);
  setupPreviewResize();
  applyPreviewWidth(getPreviewWidth());
}

async function reloadCurrentFile() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.dirty && !confirm('Reload will discard unsaved changes. Continue?')) return;
  if (tab.kind === 'explorer') await reloadExplorerTab(tab);
  else await reloadDiffTab(tab);
  const btn = document.getElementById('reload-btn');
  btn.classList.add('spin');
  setTimeout(() => btn.classList.remove('spin'), 400);
}

function togglePreview() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'explorer' || !tab.isMarkdown || tab.message) return;
  tab.previewMode = !tab.previewMode;
  previewMode = tab.previewMode;
  document.getElementById('preview-btn').classList.toggle('active', tab.previewMode);
  document.getElementById('preview-btn').textContent = tab.previewMode ? 'Editor' : 'Preview';
  if (tab.previewMode) {
    showEditorArea('preview');
    renderPreview();
  } else {
    showEditorArea('plain');
  }
}

async function renderPreview() {
  const content = plainEditor.getValue();
  const el = document.getElementById('preview-content');
  el.style.fontSize = getFontSize() + 'px';

  if (!window.marked) { el.textContent = content; return; }
  el.innerHTML = marked.parse(content);

  // Convert ```mermaid fenced blocks (rendered by marked as <pre><code class="language-mermaid">)
  // into mermaid diagrams.
  const blocks = el.querySelectorAll('code.language-mermaid, code.lang-mermaid');
  let idx = 0;
  for (const code of blocks) {
    const src = code.textContent;
    const holder = document.createElement('div');
    holder.className = 'mermaid';
    const pre = code.closest('pre');
    (pre || code).replaceWith(holder);
    if (window.mermaid) {
      try {
        const { svg } = await mermaid.render('mmd-' + Date.now() + '-' + (idx++), src);
        holder.innerHTML = svg;
      } catch (e) {
        holder.innerHTML = `<pre class="mermaid-error">Mermaid error: ${e.message}</pre>`;
      }
    }
  }
}

// --- adjustable centered width ---

function getPreviewWidth() {
  const saved = parseInt(localStorage.getItem('grv-preview-width'), 10);
  return (saved >= 480 && saved <= 1600) ? saved : 960;
}

function applyPreviewWidth(px) {
  document.getElementById('preview-wrap').style.width = px + 'px';
}

function setupPreviewResize() {
  const wrap = document.getElementById('preview-wrap');
  const container = document.getElementById('preview-container');
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    // width tracks cursor symmetrically so the column stays centered
    let w = Math.round(Math.abs(e.clientX - centerX) * 2);
    w = Math.max(480, Math.min(1600, w));
    applyPreviewWidth(w);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    localStorage.setItem('grv-preview-width', String(parseInt(wrap.style.width, 10)));
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  const startDrag = (e) => {
    dragging = true;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  document.getElementById('preview-handle-left').addEventListener('mousedown', startDrag);
  document.getElementById('preview-handle-right').addEventListener('mousedown', startDrag);
}

function markDirty() {
  const t = activeTab();
  if (t && !t.dirty) { t.dirty = true; renderTabs(); }
  isDirty = true;
}
function clearDirty() {
  const t = activeTab();
  if (t && t.dirty) { t.dirty = false; renderTabs(); }
  isDirty = false;
}

document.getElementById('save-btn').addEventListener('click', saveCurrentFile);
document.getElementById('new-terminal-btn').addEventListener('click', newTerminal);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
  // Ctrl/Cmd+W closes the active tab
  if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
    if (activeTabId) { e.preventDefault(); closeTab(activeTabId); }
  }
  // Ctrl+` opens a new terminal
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); newTerminal(); }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitActiveTerminal, 120);
});

// Resizable sidebar (helps with deep folder trees)
(function setupSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  const MIN = 180, MAX = 640;
  const saved = parseInt(localStorage.getItem('grv-sidebar-width'), 10);
  if (saved >= MIN && saved <= MAX) sidebar.style.width = saved + 'px';

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    let w = Math.max(MIN, Math.min(MAX, e.clientX));
    sidebar.style.width = w + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    localStorage.setItem('grv-sidebar-width', String(parseInt(sidebar.style.width, 10)));
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    fitActiveTerminal();
  };
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
})();

async function saveCurrentFile() {
  const tab = activeTab();
  if (!tab || tab.kind === 'diff-staged' || tab.message) return;
  const content = tab.kind === 'explorer'
    ? tab.model.getValue()
    : diffEditor.getModifiedEditor().getValue();
  try {
    const res = await fetch('/api/file-content', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content }),
    });
    const data = await res.json();
    if (data.error) { toast('Save failed: ' + data.error); return; }
    tab.dirty = false;
    renderTabs();
    loadStatus();
  } catch (err) { toast('Save failed: ' + err.message); }
}

// ---------------------------------------------------------------------------
// Source Control
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.error) return;

    document.getElementById('sb-branch').textContent = data.branch || '—';
    document.getElementById('sb-path').textContent = data.remotePath || '—';
    document.getElementById('sb-path').title = data.remotePath || '';
    document.getElementById('branch-name').textContent = data.branch || '—';

    renderList('staged-list',   data.staged,   'staged',   true);
    renderList('unstaged-list', data.unstaged, 'unstaged', false);
    renderList('untracked-list', data.untracked.map(f => ({ ...f, label: 'U' })), 'unstaged', false);

    document.getElementById('staged-count').textContent   = data.staged.length;
    document.getElementById('unstaged-count').textContent = data.unstaged.length;
    document.getElementById('untracked-count').textContent = data.untracked.length;

    const total = data.staged.length + data.unstaged.length + data.untracked.length;
    const badge = document.getElementById('scm-badge');
    badge.textContent = total;
    badge.style.display = total > 0 ? 'inline-block' : 'none';

    buildStatusMaps(data);
    refreshTreeColors();
  } catch (_) {}
}

// Build path→status maps for coloring the Explorer tree (VS Code style).
// Precedence for a file: untracked > working-tree(unstaged) > staged.
function buildStatusMaps(data) {
  fileStatusMap = new Map();
  dirStatusMap = new Map();

  const setFile = (path, letter) => {
    const cls = LETTER_CLS[letter] || 'git-modified';
    fileStatusMap.set(path, { letter: letter === '?' ? 'U' : letter, cls });
    // mark ancestor dirs; a tracked change (non-untracked) wins over untracked-only
    const tracked = cls !== 'git-untracked';
    const parts = path.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      const cur = dirStatusMap.get(acc);
      if (tracked) dirStatusMap.set(acc, 'git-modified');
      else if (!cur) dirStatusMap.set(acc, 'git-untracked');
    }
  };

  for (const f of data.staged)   setFile(f.path, f.label);
  for (const f of data.unstaged) setFile(f.path, f.label);   // overrides staged
  for (const f of data.untracked) setFile(f.path, 'U');       // overrides both
}

// Re-color existing tree rows in place (no re-render, preserves scroll).
function refreshTreeColors() {
  for (const row of document.querySelectorAll('#tree-container .tree-row')) {
    const p = row.dataset.path;
    if (!p) continue;
    const name = row.querySelector('.tree-name');
    const isDir = row.classList.contains('tree-dir');
    // clear old
    name.classList.remove('git-modified', 'git-untracked', 'git-added', 'git-deleted', 'git-renamed');
    const oldBadge = row.querySelector('.tree-status');
    if (oldBadge) oldBadge.remove();

    if (isDir) {
      const cls = dirStatusMap.get(p);
      if (cls) name.classList.add(cls);
    } else {
      const st = fileStatusMap.get(p);
      if (st) {
        name.classList.add(st.cls);
        const badge = document.createElement('span');
        badge.className = 'tree-status ' + st.cls;
        badge.textContent = st.letter;
        row.appendChild(badge);
      }
    }
  }
}

function renderList(containerId, files, mode, isStaged) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    if (currentGitSelection?.path === file.path && currentGitSelection?.mode === mode) row.classList.add('selected');

    const fileIcon = document.createElement('span');
    fileIcon.className = 'row-icon file-icon-svg';
    fileIcon.innerHTML = ICONS.file;

    const name = document.createElement('span');
    name.className = 'file-name';
    const parts = file.path.split('/');
    const base = parts.pop();
    name.textContent = base;
    if (parts.length) {
      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = ' ' + parts.join('/');
      name.appendChild(dir);
    }

    const badge = document.createElement('span');
    badge.className = `status-badge status-${file.label}`;
    badge.textContent = file.label;

    const action = document.createElement('button');
    action.className = 'file-action';
    action.textContent = isStaged ? '−' : '+';
    action.title = isStaged ? 'Unstage' : 'Stage';
    action.addEventListener('click', e => { e.stopPropagation(); toggleStage(file.path, isStaged); });

    row.addEventListener('click', () => selectDiff(file.path, mode, row));
    row.appendChild(fileIcon); row.appendChild(name); row.appendChild(action); row.appendChild(badge);
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

async function toggleStage(filePath, isStaged) {
  try {
    const res = await fetch(isStaged ? '/api/unstage' : '/api/stage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error); return; }
    loadStatus();
  } catch (err) { toast(err.message); }
}

async function selectDiff(filePath, mode, rowEl, revealLine) {
  document.querySelectorAll('.file-row.selected').forEach(r => r.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');

  const id = diffTabId(filePath, mode);
  if (getTab(id)) { activateTab(id); revealDiffLine(revealLine); return; }
  const seq = ++openSeq;

  try {
    const res = await fetch(`/api/file-diff?path=${encodeURIComponent(filePath)}&mode=${mode}`);
    const data = await res.json();
    if (data.error) { toast(data.error); return; }

    // reuse a tab a concurrent call may have created for the same diff (C2)
    let tab = getTab(id);
    if (!tab) {
      tab = {
        id, kind: mode === 'staged' ? 'diff-staged' : 'diff-unstaged',
        path: filePath, label: baseName(filePath),
        isMarkdown: false, previewMode: false, dirty: false, viewState: null,
        origModel: monaco.editor.createModel(data.original, data.language),
        modModel:  monaco.editor.createModel(data.modified,  data.language),
      };
      tabs.push(tab);
      renderTabs();
    }
    // only take over the editor if still the latest requested open (C1)
    if (seq === openSeq) { activateTab(id); revealDiffLine(revealLine); }
  } catch (err) { toast(err.message); }
}

// Scroll the diff's modified (working-tree) side to a given line and highlight it.
function revealDiffLine(line) {
  if (!line) return;
  setTimeout(() => {
    const ed = diffEditor.getModifiedEditor();
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }, 60);
}
