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
