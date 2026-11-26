const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
process.env.NODE_ENV = 'test';
const app = require('../server.js');

let server;
let baseUrl;
let adminToken;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Login as admin
  const res = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const data = await res.json();
  adminToken = data.token;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/records/reset-all rejects requests without valid confirmPhrase', async () => {
  // Missing confirmation phrase
  const resMissing = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({})
  });
  assert.strictEqual(resMissing.status, 400);
  const dataMissing = await resMissing.json();
  assert.strictEqual(dataMissing.success, false);

  // Wrong confirmation phrase (e.g. typing 'yes')
  const resWrong = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({ confirmPhrase: 'yes' })
  });
  assert.strictEqual(resWrong.status, 400);
});

test('POST /api/ojt-evaluations/reset-all rejects requests without valid confirmPhrase', async () => {
  const resWrong = await fetch(`${baseUrl}/api/ojt-evaluations/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL' })
  });
  assert.strictEqual(resWrong.status, 400);
  const dataWrong = await resWrong.json();
  assert.strictEqual(dataWrong.success, false);
});

test('Unauthenticated callers cannot invoke destructive endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' })
  });
  assert.strictEqual(res.status, 401);
});

test('GET /api/admin/audit-logs returns recorded security audit events', async () => {
  const res = await fetch(`${baseUrl}/api/admin/audit-logs`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(Array.isArray(data.logs));
  assert.ok(data.logs.length > 0);
  assert.ok(data.logs[0].action);
  assert.ok(data.logs[0].timestamp);
});

test('POST /api/records/reset-department resets department exam count with undo snapshot', async () => {
  // Login as Quality Control HOD
  const qcLogin = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'QUALITY CONTROL', password: 'hod123' })
  });
  assert.strictEqual(qcLogin.status, 200);
  const qcToken = (await qcLogin.json()).token;

  // QC HOD can reset QUALITY CONTROL
  const resetRes = await fetch(`${baseUrl}/api/records/reset-department`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dept-token': qcToken
    },
    body: JSON.stringify({ department: 'QUALITY CONTROL' })
  });
  assert.strictEqual(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.strictEqual(resetData.success, true);
  assert.ok(resetData.backupId, 'Backup ID must be generated');

  // QC HOD cannot reset PRODUCTION (403 Forbidden)
  const prodResetRes = await fetch(`${baseUrl}/api/records/reset-department`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dept-token': qcToken
    },
    body: JSON.stringify({ department: 'PRODUCTION' })
  });
  assert.strictEqual(prodResetRes.status, 403);
});
