const { test } = require('node:test');
const assert = require('node:assert');
const { fsCommand } = require('../server.js');

test('mkdir builds mkdir -p with a quoted path', () => {
  assert.match(fsCommand('mkdir', { src: 'a/b' }), /^mkdir -p -- 'a\/b'$/);
});

test('create refuses to clobber then creates an empty file', () => {
  const cmd = fsCommand('create', { src: 'a/x.txt' });
  assert.match(cmd, /\[ -e 'a\/x\.txt' \]/);
  assert.match(cmd, /: > 'a\/x\.txt'/);
});

test('delete builds rm -rf with a quoted path', () => {
  assert.match(fsCommand('delete', { src: 'a/b' }), /^rm -rf -- 'a\/b'$/);
});

test('rename guards the destination then moves', () => {
  const cmd = fsCommand('rename', { src: 'a', dest: 'b/a' });
  assert.match(cmd, /\[ -e 'b\/a' \]/);
  assert.match(cmd, /mv -- 'a' 'b\/a'/);
});

test('copy guards the destination then cp -r', () => {
  const cmd = fsCommand('copy', { src: 'a', dest: 'b/a' });
  assert.match(cmd, /\[ -e 'b\/a' \]/);
  assert.match(cmd, /cp -r -- 'a' 'b\/a'/);
});

test('single quotes in a path are escaped, not injectable', () => {
  assert.match(fsCommand('delete', { src: "a'b" }), /'a'\\''b'/);
});

test('a leading-dash path is disarmed by -- so it cannot be read as a flag', () => {
  // "-rf" must appear after the `--` separator, quoted, as an operand.
  assert.match(fsCommand('delete', { src: '-rf' }), /rm -rf -- '-rf'$/);
  assert.match(fsCommand('mkdir', { src: '-p' }), /mkdir -p -- '-p'$/);
});

test('unknown op throws', () => {
  assert.throws(() => fsCommand('chmod', { src: 'a' }), /Unknown fs op/);
});
