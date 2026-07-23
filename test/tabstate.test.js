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

test('basename returns the last path segment', () => {
  assert.strictEqual(TS.basename('a/b/c.txt'), 'c.txt');
  assert.strictEqual(TS.basename('c.txt'), 'c.txt');
  assert.strictEqual(TS.basename('a/b/'), 'b');
});

test('parentDir returns the directory, empty at root', () => {
  assert.strictEqual(TS.parentDir('a/b/c.txt'), 'a/b');
  assert.strictEqual(TS.parentDir('c.txt'), '');
});

test('joinPath joins, treating empty dir as root', () => {
  assert.strictEqual(TS.joinPath('a/b', 'c.txt'), 'a/b/c.txt');
  assert.strictEqual(TS.joinPath('', 'c.txt'), 'c.txt');
});

test('isDescendantPath: root contains all; node contains self and children', () => {
  assert.strictEqual(TS.isDescendantPath('', 'a/b'), true);
  assert.strictEqual(TS.isDescendantPath('a', 'a'), true);
  assert.strictEqual(TS.isDescendantPath('a', 'a/b'), true);
  assert.strictEqual(TS.isDescendantPath('a', 'ab'), false);
  assert.strictEqual(TS.isDescendantPath('a/b', 'a'), false);
});

test('duplicateName inserts " copy" before the extension and dedupes', () => {
  assert.strictEqual(TS.duplicateName('f.txt', []), 'f copy.txt');
  assert.strictEqual(TS.duplicateName('f.txt', ['f copy.txt']), 'f copy 2.txt');
  assert.strictEqual(TS.duplicateName('dir', ['dir copy']), 'dir copy 2');
});
