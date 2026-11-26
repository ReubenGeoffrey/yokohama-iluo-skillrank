const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const app = require('../server.js');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('CORS: Same-origin requests without Origin header succeed', async () => {
  const res = await fetch(`${baseUrl}/api/csrf-token`);
  assert.strictEqual(res.status, 200);
});

test('CORS: Same-origin requests matching Host header succeed with CORS headers', async () => {
  const u = new URL(baseUrl);
  const res = await fetch(`${baseUrl}/api/csrf-token`, {
    headers: { 'Origin': u.origin }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), u.origin);
});

test('CORS: Cloud Run domains (*.run.app) are automatically permitted', async () => {
  const cloudRunOrigin = 'https://iluo-skill-portal-xyz-as.a.run.app';
  const res = await fetch(`${baseUrl}/api/csrf-token`, {
    headers: { 'Origin': cloudRunOrigin }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), cloudRunOrigin);
});
