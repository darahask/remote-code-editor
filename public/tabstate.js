// Pure, DOM-free helpers shared by app.js (browser) and node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node
  root.TabState = api;                                                        // browser
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_BACKOFF_MS = 3000;   // cap low: reconnect is lossless (tmux), so retry often for fast recovery

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

  return { nextBackoffDelay, serializeTabs, reconcileTerminalTabs,
           basename, parentDir, joinPath, isDescendantPath, duplicateName };
});
