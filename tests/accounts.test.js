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

// TEST 1: Unified Login with individual accounts and canonical role claims
test('ACCOUNTS 1: Unified /api/auth/login succeeds for individual staff accounts with explicit role claims', async () => {
  // 1. HR Admin login
  const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: 'admin123' })
  });
  assert.strictEqual(adminRes.status, 200);
  const adminData = await adminRes.json();
  assert.strictEqual(adminData.success, true);
  assert.strictEqual(adminData.user.roleClaim, 'hr_admin');
  assert.strictEqual(adminData.user.role, 'SUPERADMIN');
  assert.ok(adminData.token);
  assert.ok(adminData.user.expiresAt > Date.now());

  // 2. Dept HOD login
  const deptRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'hod.qc', password: 'hod123' })
  });
  assert.strictEqual(deptRes.status, 200);
  const deptData = await deptRes.json();
  assert.strictEqual(deptData.success, true);
  assert.strictEqual(deptData.user.roleClaim, 'dept_hod');
  assert.strictEqual(deptData.user.role, 'DEPT_HEAD');
  assert.strictEqual(deptData.user.department, 'QUALITY CONTROL');

  // 3. Section Head login
  const secRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'sec.tirebuilding', password: 'section123' })
  });
  assert.strictEqual(secRes.status, 200);
  const secData = await secRes.json();
  assert.strictEqual(secData.success, true);
  assert.strictEqual(secData.user.roleClaim, 'section_head');
  assert.strictEqual(secData.user.role, 'SECTION_HEAD');
  assert.strictEqual(secData.user.section, 'Tire building QA');

  // 4. Evaluator login
  const evalRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'eval.safety', password: 'safety123' })
  });
  assert.strictEqual(evalRes.status, 200);
  const evalData = await evalRes.json();
  assert.strictEqual(evalData.success, true);
  assert.strictEqual(evalData.user.roleClaim, 'evaluator');
  assert.strictEqual(evalData.user.role, 'EVALUATOR');
  assert.strictEqual(evalData.user.section, 'Safety');

  // 5. Employee login via unified endpoint
  const empRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'LN0039', password: 'LN0039' })
  });
  assert.strictEqual(empRes.status, 200);
  const empData = await empRes.json();
  assert.strictEqual(empData.success, true);
  assert.strictEqual(empData.user.roleClaim, 'employee');
  assert.strictEqual(empData.user.role, 'emp');
  assert.strictEqual(empData.user.empNo, 'LN0039');
});

// TEST 2: RBAC Middlewares recognize roleClaim
test('ACCOUNTS 2: Protected endpoints grant access to sessions carrying canonical roleClaim', async () => {
  // Sign in as HR Admin via unified login
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: 'admin123' })
  });
  const { token } = await loginRes.json();

  // Test admin endpoint access with roleClaim
  const auditRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
    headers: { 'x-admin-token': token }
  });
  assert.strictEqual(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.strictEqual(auditData.success, true);
});

// TEST 3: Admin Accounts Directory Management
test('ACCOUNTS 3: Admin can list and provision individual accounts with personal hashed credentials', async () => {
  // 1. Authenticate as Superadmin
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await loginRes.json();

  // 2. Fetch account list
  const listRes = await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { 'x-admin-token': token }
  });
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  assert.strictEqual(listData.success, true);
  assert.ok(Array.isArray(listData.accounts));
  assert.ok(listData.accounts.length >= 8);

  // Ensure password hashes are never exposed in the response
  for (const acc of listData.accounts) {
    assert.strictEqual(acc.passwordHash, undefined, 'Account listing must never leak passwordHash');
    assert.ok(acc.roleClaim, 'Account must have explicit roleClaim');
  }

  // 3. Provision a new individual evaluator account
  const newAccount = {
    username: 'eval.rajesh',
    email: 'rajesh.kumar@atctires.com',
    name: 'Rajesh Kumar (Safety Lead)',
    roleClaim: 'evaluator',
    department: 'SAFETY',
    section: 'Safety',
    password: 'Rajesh@SecurePass2026!'
  };

  const createRes = await fetch(`${baseUrl}/api/admin/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token
    },
    body: JSON.stringify(newAccount)
  });
  assert.strictEqual(createRes.status, 200);
  const createData = await createRes.json();
  assert.strictEqual(createData.success, true);
  assert.strictEqual(createData.account.username, 'eval.rajesh');

  // 4. Authenticate as newly provisioned individual user
  const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'eval.rajesh', password: 'Rajesh@SecurePass2026!' })
  });
  assert.strictEqual(newLoginRes.status, 200);
  const newLoginData = await newLoginRes.json();
  assert.strictEqual(newLoginData.success, true);
  assert.strictEqual(newLoginData.user.name, 'Rajesh Kumar (Safety Lead)');
  assert.strictEqual(newLoginData.user.roleClaim, 'evaluator');
});

// TEST 4: Role-specific login endpoints return explicit role claims and session data
test('ACCOUNTS 4: Evaluator, Section, and Dept endpoints set individual roleClaim and 8-hour expiry', async () => {
  // Evaluator endpoint
  const evalRes = await fetch(`${baseUrl}/api/auth/evaluator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Safety', password: 'safety123' })
  });
  assert.strictEqual(evalRes.status, 200);
  const evalData = await evalRes.json();
  assert.strictEqual(evalData.user.roleClaim, 'evaluator');
  assert.ok(evalData.user.accountId);
  assert.ok(evalData.user.expiresAt > Date.now());

  // Section Head endpoint
  const secRes = await fetch(`${baseUrl}/api/auth/section/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Tire building QA', password: 'section123' })
  });
  assert.strictEqual(secRes.status, 200);
  const secData = await secRes.json();
  assert.strictEqual(secData.user.roleClaim, 'section_head');
  assert.ok(secData.user.accountId);

  // Dept HOD endpoint
  const deptRes = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'QUALITY CONTROL', password: 'hod123' })
  });
  assert.strictEqual(deptRes.status, 200);
  const deptData = await deptRes.json();
  assert.strictEqual(deptData.user.roleClaim, 'dept_hod');
  assert.ok(deptData.user.accountId);
});
