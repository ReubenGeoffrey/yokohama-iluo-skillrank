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

test('SPA ROUTING: Root / serves index.html on single unified domain', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ILUO Skill Assessment Portal') || text.includes('navbarSystemTitle'));
});

test('SPA ROUTING: Direct path /employee serves employee.html on same domain', async () => {
  const res = await fetch(`${baseUrl}/employee`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Employee Skill Assessment Portal') || text.includes('employee.js'));
});

test('SPA ROUTING: Deep management client route falls back to index.html without 404', async () => {
  const res = await fetch(`${baseUrl}/secure-control/dashboard`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ILUO Skill Assessment Portal') || text.includes('navbarSystemTitle'));
});

test('SPA ROUTING: Missing static file (.png, .js, .css) returns 404 JSON, not HTML', async () => {
  const res = await fetch(`${baseUrl}/non_existent_image.png`);
  assert.strictEqual(res.status, 404);
  const json = await res.json();
  assert.strictEqual(json.success, false);
});
