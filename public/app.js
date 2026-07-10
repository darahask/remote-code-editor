// ---------------------------------------------------------------------------
// Icons (inline SVG, currentColor so they follow the theme)
// ---------------------------------------------------------------------------

const ICONS = {
  chevron: '<svg class="ic ic-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.5 3.5l5 4.5-5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="ic ic-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3L7.6 4.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="currentColor" opacity="0.9"/></svg>',
  folderOpen: '<svg class="ic ic-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3L7.6 4.5h6a1 1 0 0 1 1 1v1H4.3a1 1 0 0 0-.95.68L1.5 12.8z" fill="currentColor" opacity="0.55"/><path d="M3.35 6.5A1 1 0 0 1 4.3 5.8h10.4a.7.7 0 0 1 .66.93l-1.6 5A1 1 0 0 1 12.8 12.5H1.9z" fill="currentColor" opacity="0.9"/></svg>',
  file: '<svg class="ic ic-file" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 1.75A.75.75 0 0 1 4.75 1H9.5l3.5 3.5v9.75a.75.75 0 0 1-.75.75h-7.5A.75.75 0 0 1 4 14.25z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.25 1.25v3.5h3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  terminal: '<svg class="ic ic-term" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2.2 2L4 10M8 10.2h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
const expandedDirs = new Set();
let currentGitSelection = null;
let profileState = { profiles: {}, active: null }; // cached, no re-fetch on panel open
let currentIsMarkdown = false;
let previewMode = false;

// Multi-tab state. Each tab holds its own Monaco model(s) + view state.
let tabs = [];
let activeTabId = null;
let treeData = null; // cached tree for reveal-without-refetch

function isMarkdownPath(p) { return /\.(md|markdown|mdx)$/i.test(p || ''); }
function baseName(p) { return p.split('/').pop(); }
function explorerTabId(path) { return 'file:' + path; }
function diffTabId(path, mode) { return 'diff:' + mode + ':' + path; }
function getTab(id) { return tabs.find(t => t.id === id); }
function activeTab() { return getTab(activeTabId); }

// ---------------------------------------------------------------------------
// Monaco
// ---------------------------------------------------------------------------

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  monaco.editor.defineTheme('warm-light', {
    base: 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': '#F6F3EE',
      'editor.lineHighlightBackground': '#EDE8DF',
      'editorLineNumber.foreground': '#B0A898',
      'editorLineNumber.activeForeground': '#7A6E62',
      'diffEditor.insertedTextBackground': '#D0E8D080',
      'diffEditor.removedTextBackground': '#ECCCC880',
    },
  });
  monaco.editor.setTheme('warm-light');

  const fontSize = getFontSize();

  diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor-container'), {
    automaticLayout: true, renderSideBySide: true,
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
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
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

async function activateProfile(name) {
  if (name === profileState.active) { closeProfilesOverlay(); return; }
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
    delete profileState.profiles[name];
    if (profileState.active === name) profileState.active = Object.keys(profileState.profiles)[0] || null;
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
      row.appendChild(twist);
      row.appendChild(folder);
      row.appendChild(name);
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

      row.addEventListener('click', () => {
        const opening = childContainer.style.display === 'none';
        if (opening) renderChildren();
        childContainer.style.display = opening ? 'block' : 'none';
        twist.classList.toggle('open', opening);
        folder.innerHTML = opening ? ICONS.folderOpen : ICONS.folder;
        if (opening) expandedDirs.add(fullPath);
        else expandedDirs.delete(fullPath);
      });
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
      row.appendChild(twistSpacer);
      row.appendChild(icon);
      row.appendChild(name);
      row.addEventListener('click', () => openFile(node.path));
      frag.appendChild(row);
    }
  }
  container.appendChild(frag);
}

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

// Open a file in a tab (reusing an existing tab if already open) and reveal it.
async function openFile(filePath) {
  revealInTree(filePath);
  const id = explorerTabId(filePath);
  if (getTab(id)) { activateTab(id); return; }
  try {
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) { toast(data.error); return; }

    const tab = {
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
    activateTab(id);
  } catch (err) { toast('Could not load file: ' + err.message); }
}

async function reloadExplorerTab(tab) {
  const res = await fetch(`/api/file-content?path=${encodeURIComponent(tab.path)}`);
  const data = await res.json();
  if (data.error) { toast(data.error); return; }
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

const TERM_THEME = {
  background: '#F6F3EE', foreground: '#2E2A24',
  cursor: '#9B6E2E', cursorAccent: '#F6F3EE', selectionBackground: '#D8D2C4',
  black: '#2E2A24', red: '#B04030', green: '#3D7A3D', yellow: '#8F6A20',
  blue: '#3A6E8F', magenta: '#8A5A8A', cyan: '#3A8A8A', white: '#C8C0B4',
  brightBlack: '#7A7060', brightRed: '#C05040', brightGreen: '#4D8A4D', brightYellow: '#9F7A30',
  brightBlue: '#4A7E9F', brightMagenta: '#9A6A9A', brightCyan: '#4A9A9A', brightWhite: '#2E2A24',
};
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
    theme: TERM_THEME,
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
      plainEditor.setModel(tab.model);
      plainEditor.updateOptions({ readOnly: false });
      showEditorArea('plain');
      if (tab.viewState) plainEditor.restoreViewState(tab.viewState);
      ensureDecorations(tab);
    }
  } else {
    document.getElementById('preview-btn').style.display = 'none';
    const editable = tab.kind === 'diff-unstaged';
    document.getElementById('save-btn').style.display = editable ? 'inline-block' : 'none';
    document.getElementById('readonly-note').style.display = editable ? 'none' : 'inline';
    diffEditor.setModel({ original: tab.origModel, modified: tab.modModel });
    diffEditor.getModifiedEditor().updateOptions({ readOnly: !editable });
    showEditorArea('diff');
    if (tab.viewState) diffEditor.restoreViewState(tab.viewState);
  }

  renderTabs();
  syncTreeSelection(tab);
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
  tab.model?.dispose(); tab.origModel?.dispose(); tab.modModel?.dispose();
  if (tab.kind === 'terminal') {
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
  } catch (_) {}
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

  try {
    const res = await fetch(`/api/file-diff?path=${encodeURIComponent(filePath)}&mode=${mode}`);
    const data = await res.json();
    if (data.error) { toast(data.error); return; }

    const tab = {
      id, kind: mode === 'staged' ? 'diff-staged' : 'diff-unstaged',
      path: filePath, label: baseName(filePath),
      isMarkdown: false, previewMode: false, dirty: false, viewState: null,
      origModel: monaco.editor.createModel(data.original, data.language),
      modModel:  monaco.editor.createModel(data.modified,  data.language),
    };
    tabs.push(tab);
    activateTab(id);
    revealDiffLine(revealLine);
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
