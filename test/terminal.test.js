const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../server.js');

test('sanitizeSessionId accepts valid ids', () => {
  assert.strictEqual(t.sanitizeSessionId('abc123_DEF'), 'abc123_DEF');
});

test('sanitizeSessionId rejects shell metacharacters', () => {
  assert.strictEqual(t.sanitizeSessionId('a; rm -rf /'), null);
  assert.strictEqual(t.sanitizeSessionId('a.b'), null);
  assert.strictEqual(t.sanitizeSessionId('a:b'), null);
  assert.strictEqual(t.sanitizeSessionId(''), null);
  assert.strictEqual(t.sanitizeSessionId('$(x)'), null);
});

test('sanitizeSessionId rejects overly long ids', () => {
  assert.strictEqual(t.sanitizeSessionId('a'.repeat(65)), null);
});

test('tmuxSessionName prefixes with grv_', () => {
  assert.strictEqual(t.tmuxSessionName('deadbeef'), 'grv_deadbeef');
});

test('remoteTerminalCommand builds an attach-or-create tmux command', () => {
  const cmd = t.remoteTerminalCommand({ repoPath: '/home/me/repo', sessionName: 'grv_x' });
  assert.match(cmd, /cd '\/home\/me\/repo' 2>\/dev\/null; /);
  assert.match(cmd, /exec tmux new-session -A -s grv_x \$SHELL -l/);
});

test('remoteTerminalCommand quotes paths with spaces/quotes safely', () => {
  const cmd = t.remoteTerminalCommand({ repoPath: "/tmp/a b'c", sessionName: 'grv_x' });
  assert.ok(cmd.includes(`cd '/tmp/a b'\\''c'`));
});

test('remoteFallbackCommand is a plain login shell', () => {
  const cmd = t.remoteFallbackCommand({ repoPath: '/home/me/repo' });
  assert.match(cmd, /cd '\/home\/me\/repo' 2>\/dev\/null; exec \$SHELL -l/);
  assert.ok(!cmd.includes('tmux'));
});
