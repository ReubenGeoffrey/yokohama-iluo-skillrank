const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

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

// TEST 1: HR can log into Management Portal and access authorized HR functions
test('TWO-PORTAL 1: HR can authenticate and access Management functions', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.strictEqual(loginData.success, true);
  const adminToken = loginData.token;

  // Access HR stats
  const statsRes = await fetch(`${baseUrl}/api/admin/dashboard-stats`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(statsRes.status, 200);
  const statsData = await statsRes.json();
  assert.ok(statsData.data && statsData.data.totalEmployees, 'Admin must receive employee stats');
});

// TEST 2: HOD cannot access an unrelated department
test('TWO-PORTAL 2: Department HOD is strictly scoped to assigned department', async () => {
  // Login as Quality Control HOD
  const qcLogin = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'QUALITY CONTROL', password: 'hod123' })
  });
  assert.strictEqual(qcLogin.status, 200);
  const qcToken = (await qcLogin.json()).token;

  // Query records
  const recRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-dept-token': qcToken }
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();

  // All returned records must belong to an employee associated with Quality Control
  const employees = JSON.parse(fs.readFileSync('custom_employees.json', 'utf8'));

  for (const empNo of Object.keys(recData.records || {})) {
    const hasQc = employees.some(e => e.empNo === empNo && (
      (e.dept || '').toLowerCase().includes('quality') ||
      (e.dept || '').toLowerCase().includes('qc')
    ));
    assert.ok(hasQc, `HOD of QC must only see QC-associated employee ${empNo}`);
  }
});

// TEST 3: Section Supervisor cannot access an unrelated section
test('TWO-PORTAL 3: Section Supervisor is strictly scoped to assigned QA section', async () => {
  const secLogin = await fetch(`${baseUrl}/api/auth/section/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Tire building QA', password: 'section123' })
  });
  assert.strictEqual(secLogin.status, 200);
  const secToken = (await secLogin.json()).token;

  const recRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-section-token': secToken }
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();

  const employees = JSON.parse(fs.readFileSync('custom_employees.json', 'utf8'));

  function normalizeSec(sec) {
    let s = (sec || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (s.includes('building') || s.includes('tbm')) return 'tire building qa';
    if (s.includes('curing')) return 'tire curing qa';
    if (s.includes('solid')) return 'solid tire qa';
    if (s.includes('preparatory')) return 'preparatory qa';
    if (s.includes('fid')) return 'fid inspector qa';
    if (s.includes('warehouse')) return 'warehouse qa';
    if (s.includes('finish')) return 'final finish qa';
    return s;
  }

  for (const empNo of Object.keys(recData.records || {})) {
    const hasTb = employees.some(e => e.empNo === empNo && normalizeSec(e.section) === 'tire building qa');
    assert.ok(hasTb, `Tire Building supervisor must not see non-TB employee ${empNo}`);
  }
});

// TEST 4: Evaluator cannot perform unauthorized administration functions
test('TWO-PORTAL 4: Evaluator cannot invoke admin or superadmin endpoints', async () => {
  const evalLogin = await fetch(`${baseUrl}/api/auth/evaluator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'Safety', password: 'safety123' })
  });
  assert.strictEqual(evalLogin.status, 200);
  const evalToken = (await evalLogin.json()).token;

  // Attempt to access admin audit logs -> 403 Forbidden
  const auditRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
    headers: { 'x-evaluator-token': evalToken }
  });
  assert.strictEqual(auditRes.status, 403);

  // Attempt to reset all records -> 403 Forbidden
  const resetRes = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-evaluator-token': evalToken
    },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' })
  });
  assert.strictEqual(resetRes.status, 403);
});

// TEST 5: Employee can log into Employee Portal and view own information
test('TWO-PORTAL 5: Employee can log in and view own profile data', async () => {
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900262', password: '1234' })
  });
  assert.strictEqual(empLogin.status, 200);
  const empData = await empLogin.json();
  assert.strictEqual(empData.success, true);
  assert.strictEqual(empData.employee.empNo, '900262');
  const empToken = empData.token;

  const meRes = await fetch(`${baseUrl}/api/auth/employee/me`, {
    headers: { 'x-emp-token': empToken }
  });
  assert.strictEqual(meRes.status, 200);
  const meData = await meRes.json();
  assert.strictEqual(meData.authenticated, true);
  assert.strictEqual(meData.employee.empNo, '900262');
});

// TEST 6: Employee cannot access another employee's records or reports (IDOR protection)
test('TWO-PORTAL 6: Employee is strictly isolated from other employees records', async () => {
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900262', password: '1234' })
  });
  const token = (await empLogin.json()).token;

  // 1. Direct record lookup returns only own record
  const recRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-emp-token': token }
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();
  const keys = Object.keys(recData.records || {});
  assert.ok(keys.length <= 1);
  if (keys.length === 1) {
    assert.strictEqual(keys[0], '900262');
  }

  // 2. Direct request for another employee's DOCX report -> 403
  const docxRes = await fetch(`${baseUrl}/api/employee-docx/900445`, {
    headers: { 'x-emp-token': token }
  });
  assert.strictEqual(docxRes.status, 403);
});

// TEST 7: Employee cannot access Management Portal APIs
test('TWO-PORTAL 7: Employee cannot access Management APIs directly', async () => {
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900262', password: '1234' })
  });
  const token = (await empLogin.json()).token;

  const endpoints = [
    { url: '/api/admin/audit-logs', method: 'GET' },
    { url: '/api/admin/dashboard-stats', method: 'GET' },
    { url: '/api/settings', method: 'GET' },
    { url: '/api/questions', method: 'POST', body: JSON.stringify({ text: 'test' }) },
    { url: '/api/employees', method: 'POST', body: JSON.stringify({ name: 'test' }) },
    { url: '/api/records/reset-all', method: 'POST', body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' }) }
  ];

  for (const ep of endpoints) {
    const res = await fetch(`${baseUrl}${ep.url}`, {
      method: ep.method,
      headers: {
        'Content-Type': 'application/json',
        'x-emp-token': token
      },
      body: ep.body
    });
    assert.strictEqual(
      res.status === 401 || res.status === 403,
      true,
      `Employee must be blocked from ${ep.method} ${ep.url} with 401/403`
    );
  }
});

// TEST 8: Assessment answers and submissions persist in shared backend
test('TWO-PORTAL 8: Assessment lifecycle persists authoritatively in shared backend', async () => {
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900191', password: '1234' })
  });
  const token = (await empLogin.json()).token;

  // Start Exam
  const startRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': token
    },
    body: JSON.stringify({ empNo: '900191', targetLevel: 'U', forceRetake: true })
  });
  assert.strictEqual(startRes.status, 200);
  const exam = (await startRes.json()).activeExam;
  assert.ok(exam.questions.length > 0);

  // Submit Exam
  const submitRes = await fetch(`${baseUrl}/api/exam/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': token
    },
    body: JSON.stringify({
      empNo: '900191',
      answers: { [exam.questions[0].id]: 0 }
    })
  });
  assert.strictEqual(submitRes.status, 200);
  const submitData = await submitRes.json();
  assert.strictEqual(submitData.success, true);
  assert.strictEqual(submitData.record.isCompleted, true);
  assert.ok(submitData.record.categoryMarks);
});

// TEST 9: Invalid credentials and expired sessions are safely rejected
test('TWO-PORTAL 9: Invalid credentials and expired sessions are rejected safely', async () => {
  // Bad employee credentials
  const badLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900191', password: 'wrongpassword' })
  });
  assert.strictEqual(badLogin.status, 401);

  // Fake token rejected
  const fakeTokenRes = await fetch(`${baseUrl}/api/auth/employee/me`, {
    headers: { 'x-emp-token': 'fake.invalid.token' }
  });
  assert.strictEqual(fakeTokenRes.status, 200);
  const fakeData = await fakeTokenRes.json();
  assert.strictEqual(fakeData.authenticated, false);
});

// TEST 10: Multi-site entry points and host routing serve correct HTML
test('TWO-PORTAL 10: Host and path routing serves Employee Portal vs Management Portal', async () => {
  // 1. Direct path /employee serves employee.html
  const empPathRes = await fetch(`${baseUrl}/employee`);
  assert.strictEqual(empPathRes.status, 200);
  const empPathHtml = await empPathRes.text();
  assert.ok(empPathHtml.includes('Employee Skill Assessment Portal'));
  assert.ok(empPathHtml.includes('employee.js'));

  // 2. Direct path /management serves index.html
  const mgtPathRes = await fetch(`${baseUrl}/management`);
  assert.strictEqual(mgtPathRes.status, 200);
  const mgtPathHtml = await mgtPathRes.text();
  assert.ok(mgtPathHtml.includes('Management &amp; Operations Portal') || mgtPathHtml.includes('HR CONTROL CENTER'));

  // 3. Host employee.yourdomain.in on root / serves employee.html
  const hostEmpRes = await fetch(`${baseUrl}/`, {
    headers: { 'x-forwarded-host': 'employee.yourdomain.in' }
  });
  assert.strictEqual(hostEmpRes.status, 200);
  const hostEmpHtml = await hostEmpRes.text();
  assert.ok(hostEmpHtml.includes('Employee Skill Assessment Portal'));

  // 4. Host management.yourdomain.in on root / serves index.html
  const hostMgtRes = await fetch(`${baseUrl}/`, {
    headers: { 'x-forwarded-host': 'management.yourdomain.in' }
  });
  assert.strictEqual(hostMgtRes.status, 200);
  const hostMgtHtml = await hostMgtRes.text();
  assert.ok(hostMgtHtml.includes('Management &amp; Operations Portal') || hostMgtHtml.includes('HR CONTROL CENTER'));
});
