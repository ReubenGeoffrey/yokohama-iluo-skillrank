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
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/auth/admin/login rejects incorrect password', async () => {
  const res = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrongpassword' })
  });
  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});

test('POST /api/auth/evaluator/login succeeds with valid credentials and sets session', async () => {
  const res = await fetch(`${baseUrl}/api/auth/evaluator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Safety', password: 'safety123' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.user.role, 'EVALUATOR');
  assert.strictEqual(data.user.section, 'Safety');
  assert.ok(data.token);
});

test('POST /api/auth/evaluator/login rejects invalid password', async () => {
  const res = await fetch(`${baseUrl}/api/auth/evaluator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Safety', password: 'invalidpassword' })
  });
  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});

test('POST /api/auth/section/login succeeds with valid credentials', async () => {
  const res = await fetch(`${baseUrl}/api/auth/section/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Tire building QA', password: 'section123' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.user.role, 'SECTION_HEAD');
  assert.strictEqual(data.user.section, 'Tire building QA');
});

test('POST /api/auth/dept/login succeeds with valid credentials for QUALITY CONTROL', async () => {
  const res = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'QUALITY CONTROL', password: 'hod123' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.user.role, 'DEPT_HEAD');
  assert.strictEqual(data.user.department, 'QUALITY CONTROL');
});

test('POST /api/auth/dept/login succeeds with valid credentials for PRODUCTION', async () => {
  const res = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'PRODUCTION', password: 'hod123' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.user.role, 'DEPT_HEAD');
  assert.strictEqual(data.user.department, 'PRODUCTION');
});

test('POST /api/auth/employee/login succeeds for valid employee and rejects invalid', async () => {
  // Valid employee from database
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.employee.empNo, 'LN0039');
  assert.strictEqual(data.employee.role, 'emp');

  // Invalid employee
  const resBad = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'NONEXISTENT999', password: '1234' })
  });
  assert.strictEqual(resBad.status, 401);
});
