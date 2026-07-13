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
