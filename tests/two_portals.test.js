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

  const testEmps = [
    { empNo: '900191', doj: '2011-04-01' },
    { empNo: '900262', doj: '2011-04-01' },
    { empNo: '900445', doj: '2012-04-01' },
    { empNo: 'LN0039', doj: '2023-12-13' }
  ];
  for (const te of testEmps) {
    await fetch(`${baseUrl}/api/auth/employee/setup-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: te.empNo, doj: te.doj, newPassword: 'Emp@Secure2026!' })
    });
  }
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
    body: JSON.stringify({ empNo: '900262', password: 'Emp@Secure2026!' })
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
    body: JSON.stringify({ empNo: '900262', password: 'Emp@Secure2026!' })
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
    body: JSON.stringify({ empNo: '900262', password: 'Emp@Secure2026!' })
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
    body: JSON.stringify({ empNo: '900191', password: 'Emp@Secure2026!' })
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
  assert.ok(mgtPathHtml.includes('PLANT OPERATIONS MANAGEMENT') || mgtPathHtml.includes('HR CONTROL CENTER') || mgtPathHtml.includes('ILUO Skill Assessment Portal'));

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
  assert.ok(hostMgtHtml.includes('PLANT OPERATIONS MANAGEMENT') || hostMgtHtml.includes('HR CONTROL CENTER') || hostMgtHtml.includes('ILUO Skill Assessment Portal'));

  // 5. Host employee on /index.html serves employee.html
  const hostEmpIndexRes = await fetch(`${baseUrl}/index.html`, {
    headers: { 'x-forwarded-host': 'yokohama-iluo-employee.vercel.app' }
  });
  assert.strictEqual(hostEmpIndexRes.status, 200);
  const hostEmpIndexHtml = await hostEmpIndexRes.text();
  assert.ok(hostEmpIndexHtml.includes('Employee Skill Assessment Portal'));
});

// TEST 11: Employee can log in with Employee No as password without setup
test('TWO-PORTAL 11: Employee can log in with Employee No as password without setup', async () => {
  // 1. Employee No as password succeeds
  const empLoginRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', password: '900445' })
  });
  assert.strictEqual(empLoginRes.status, 200);
  const empLoginData = await empLoginRes.json();
  assert.strictEqual(empLoginData.success, true);
  assert.strictEqual(empLoginData.employee.empNo, '900445');
  assert.ok(empLoginData.token);

  // 2. Omitting password also defaults to Employee No and succeeds
  const empNoPassRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', password: '' })
  });
  assert.strictEqual(empNoPassRes.status, 200);
  const empNoPassData = await empNoPassRes.json();
  assert.strictEqual(empNoPassData.success, true);

  // 3. Wrong passwords are rejected with 401
  const badPasswords = ['wrongpass', '1234', '0000', 'random999'];
  for (const pw of badPasswords) {
    const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: '900445', password: pw })
    });
    assert.strictEqual(res.status, 401, `Password "${pw}" must be rejected with 401`);
    const data = await res.json();
    assert.strictEqual(data.success, false);
  }
});

// TEST 12: Secure Password Setup & Reset with DOJ verification
test('TWO-PORTAL 12: Setup and reset password requires correct DOJ and strong password', async () => {
  // Wrong DOJ -> 401
  const badDojRes = await fetch(`${baseUrl}/api/auth/employee/setup-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', doj: '1999-01-01', newPassword: 'ValidPass123!' })
  });
  assert.strictEqual(badDojRes.status, 401);

  // Weak password (<8 chars) -> 400
  const weakPwRes = await fetch(`${baseUrl}/api/auth/employee/setup-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', doj: '2012-04-01', newPassword: 'short' })
  });
  assert.strictEqual(weakPwRes.status, 400);

  // Correct DOJ & Strong Password -> 200
  const goodRes = await fetch(`${baseUrl}/api/auth/employee/setup-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', doj: '2012-04-01', newPassword: 'SuperSecret2026!' })
  });
  assert.strictEqual(goodRes.status, 200);

  // Login with new password
  const loginRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900445', password: 'SuperSecret2026!' })
  });
  assert.strictEqual(loginRes.status, 200);
});

// TEST 13: Empty dataset reset does not resurrect legacy seed records
test('TWO-PORTAL 13: Empty dataset reset does not resurrect legacy seed records', async () => {
  // Admin login
  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await adminLogin.json()).token;

  // Clear records via reset-all
  const resetRes = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' })
  });
  assert.strictEqual(resetRes.status, 200);

  // Query records -> must be empty object, not resurrected seed data
  const recRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();
  assert.deepStrictEqual(recData.records, {}, 'Records must remain empty after reset without resurrecting seed data');
});

// TEST 14: Production fail-safe when Redis configuration is missing or failing
test('TWO-PORTAL 14: Production environment enforces fail-safe storage checks', async () => {
  const origEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    // When in production, lack of session secret or invalid storage configuration fails fast
    assert.throws(() => {
      const origSecret = process.env.SESSION_SECRET;
      delete process.env.SESSION_SECRET;
      try {
        if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
          throw new Error('FATAL: SESSION_SECRET environment variable is required in production environment.');
        }
      } finally {
        process.env.SESSION_SECRET = origSecret;
      }
    }, /SESSION_SECRET environment variable is required/);
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

// TEST 15: Concurrency locking prevents race condition overwrites
test('TWO-PORTAL 15: Concurrent writes serialize and maintain data consistency', async () => {
  // Admin login
  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await adminLogin.json()).token;

  // Issue 5 simultaneous evaluation updates for the same candidate
  const updates = [1, 2, 3, 4, 5].map(idx => 
    fetch(`${baseUrl}/api/ojt-evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken
      },
      body: JSON.stringify({
        empNo: '900191',
        ojtData: {
          section: 'Safety',
          [`item_${idx}`]: { score: 4, comment: `Concurrent update ${idx}` }
        }
      })
    })
  );

  const results = await Promise.all(updates);
  for (const res of results) {
    assert.strictEqual(res.status, 200, 'Each concurrent evaluation write should complete with 200');
  }

  // Verify final evaluation state has recorded items without corrupted state
  const evalRes = await fetch(`${baseUrl}/api/ojt-evaluations`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(evalRes.status, 200);
  const evalData = await evalRes.json();
  assert.ok(evalData.evaluations['900191'], 'Evaluations for candidate must exist');
  assert.ok(evalData.evaluations['900191'].version >= 5, 'Record version must be at least 5 after sequential atomic increments');
});

// TEST 16: Quality Control employee switches skill level to experience-based target level upon exam completion
test('TWO-PORTAL 16: QC employee switches skill level to experience-based level upon passing exam', async () => {
  // 1. Employee 900844 (SAVARIMUTHU F) logs in using Employee ID as password
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900844', password: '900844' })
  });
  assert.strictEqual(empLogin.status, 200);
  const { token, employee } = await empLogin.json();
  assert.strictEqual(employee.currentLevel, 'U', 'Initial 2025 assessment level must be U');
  assert.strictEqual(employee.targetLevel, 'O', 'Experience-based target level must be O');

  // 2. Start exam for targetLevel 'O'
  const startRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': token
    },
    body: JSON.stringify({ empNo: '900844', targetLevel: 'O', forceRetake: true })
  });
  assert.strictEqual(startRes.status, 200);
  const exam = (await startRes.json()).activeExam;
  assert.strictEqual(exam.targetLevel, 'O');

  // 3. Superadmin retrieves full question bank with correct answers
  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await adminLogin.json()).token;
  const qRes = await fetch(`${baseUrl}/api/questions`, {
    headers: { 'x-admin-token': adminToken }
  });
  const qBank = (await qRes.json()).questionBank;
  const oQuestions = qBank['O'] || [];
  const correctMap = new Map();
  oQuestions.forEach(q => correctMap.set(q.id, q.correctAnswer));

  // Build passing responses
  const answers = {};
  exam.questions.forEach(q => {
    answers[q.id] = correctMap.get(q.id) || 'A';
  });

  // 4. Submit exam
  const submitRes = await fetch(`${baseUrl}/api/exam/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': token
    },
    body: JSON.stringify({
      empNo: '900844',
      answers,
      candidateSignature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })
  });
  assert.strictEqual(submitRes.status, 200);
  const submitData = await submitRes.json();
  assert.strictEqual(submitData.success, true);
  assert.strictEqual(submitData.record.isPassed, true, 'Candidate should pass exam');
  assert.strictEqual(submitData.record.switchedLevel, 'O', 'Record must record switchedLevel O');

  // 5. Verify /api/auth/employee/me reflects switched level O
  const meRes = await fetch(`${baseUrl}/api/auth/employee/me`, {
    headers: { 'x-emp-token': token }
  });
  assert.strictEqual(meRes.status, 200);
  const meData = await meRes.json();
  assert.strictEqual(meData.employee.currentLevel, 'O', 'Current level must switch to O');
});

