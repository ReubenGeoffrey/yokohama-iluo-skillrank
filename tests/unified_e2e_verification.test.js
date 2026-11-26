const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
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

test('UNIFIED E2E 1: GET / serves main portal index.html with 200 OK', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('ILUO Skill Assessment Portal') || html.includes('navbarSystemTitle'));
});

test('UNIFIED E2E 2: GET /employee serves candidate portal employee.html with 200 OK', async () => {
  const res = await fetch(`${baseUrl}/employee`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Employee Skill Assessment Portal') || html.includes('employee.js'));
});

test('UNIFIED E2E 3: SPA deep links (e.g. /secure-control) serve index.html with 200 OK', async () => {
  const res = await fetch(`${baseUrl}/secure-control`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('ILUO Skill Assessment Portal') || html.includes('navbarSystemTitle'));
});

test('UNIFIED E2E 4: GET /healthz zero-I/O health probe returns 200 OK', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
});

test('UNIFIED E2E 5: GET /api/csrf-token succeeds on single unified URL', async () => {
  const res = await fetch(`${baseUrl}/api/csrf-token`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.csrfToken, 'CSRF token must be present');
});

test('UNIFIED E2E 6: GET /api/health returns database persistence status', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.ok(data.database, 'Database health object must exist');
});

test('UNIFIED E2E 7: Management login and Excel master export succeed on single URL', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(loginRes.status, 200);
  const adminToken = (await loginRes.json()).token;
  assert.ok(adminToken, 'Admin token returned');

  const excelRes = await fetch(`${baseUrl}/api/export/production-excel`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(excelRes.status, 200);
  assert.strictEqual(
    excelRes.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  const buf = await excelRes.arrayBuffer();
  assert.ok(buf.byteLength > 50000, 'Excel output must be non-empty');
});

test('UNIFIED E2E 8: Section completion PDF export with headless queue succeeds on single URL', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await loginRes.json()).token;

  const pdfRes = await fetch(`${baseUrl}/api/export/section-summary-pdf?scope=production`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(pdfRes.status, 200);
  assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
  const buf = await pdfRes.arrayBuffer();
  assert.ok(buf.byteLength > 1000, 'PDF output must be non-empty');
});
