const { test } = require('node:test');
const assert = require('node:assert');
const { app } = require('../server.js');

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { await fn(base); resolve(); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
    srv.on('error', reject);
  });
}

test('DELETE /api/term-session rejects an invalid session id with 400 (before any ssh)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/term-session?session=${encodeURIComponent('a; rm -rf /')}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid session/i);
  });
});

test('DELETE /api/term-session rejects a missing session id with 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/term-session`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
  });
});
