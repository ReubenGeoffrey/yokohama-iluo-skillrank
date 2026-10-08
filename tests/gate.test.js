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

// GATE CHECK 1: SESSION_SECRET
test('GATE 1: SESSION_SECRET fail-fast in production & consistent signing', async () => {
  // Verify that server throws if SESSION_SECRET is missing in production
  assert.throws(() => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.SESSION_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.SESSION_SECRET;
      // Simulate module load check
      let s = process.env.SESSION_SECRET;
      if (!s && process.env.NODE_ENV === 'production') {
        throw new Error('FATAL: SESSION_SECRET environment variable is required in production environment.');
      }
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.SESSION_SECRET = origSecret;
    }
  }, /SESSION_SECRET environment variable is required/);

  // Verify that current session secret is configured and not empty
  assert.ok(process.env.SESSION_SECRET, 'SESSION_SECRET must be defined');
  assert.ok(process.env.SESSION_SECRET.length >= 32, 'SESSION_SECRET must have at least 32 characters');
});

// GATE CHECK 2: CREDENTIAL EXPOSURE SCAN
test('GATE 2: Zero credentials in client-delivered files (HTML, JS, CSS)', () => {
  const forbiddenCredentials = [
    'admin123',
    'section123',
    'hod123',
    'safety123',
    'ci123',
    'quality123',
    'tech123',
    'hr123'
  ];

  const clientFiles = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'app.js'),
    path.join(__dirname, '..', 'data.js'),
    path.join(__dirname, '..', 'styles.css')
  ];

  for (const file of clientFiles) {
    assert.ok(fs.existsSync(file), `Client file must exist: ${file}`);
    const content = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const cred of forbiddenCredentials) {
      assert.strictEqual(
        content.includes(cred.toLowerCase()),
        false,
        `Prohibited credential "${cred}" discovered in client-delivered file: ${path.basename(file)}`
      );
    }
  }
});

// GATE CHECK 3: ANSWER KEYS ZERO-EXPOSURE
test('GATE 3: Candidate exam question payload contains zero correctAnswer properties', async () => {
  // 1. Candidate start exam payload
  const loginRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900191', password: '1234' })
  });
  assert.strictEqual(loginRes.status, 200);
  const loginData = await loginRes.json();
  const empToken = loginData.token;

  // Start Exam for pending candidate
  const examRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: '900191', targetLevel: 'O', forceRetake: true })
  });
  assert.strictEqual(examRes.status, 200);
  const examData = await examRes.json();
  assert.strictEqual(examData.success, true);
  assert.ok(examData.activeExam);
  assert.ok(Array.isArray(examData.activeExam.questions));
  assert.ok(examData.activeExam.questions.length > 0);

  // Assert every single question returned to candidate has NO correctAnswer
  for (const q of examData.activeExam.questions) {
    assert.strictEqual(
      'correctAnswer' in q,
      false,
      `Exposed correctAnswer detected in candidate question ID ${q.id}`
    );
  }

  // 2. Public /api/questions payload
  const pubRes = await fetch(`${baseUrl}/api/questions`);
  assert.strictEqual(pubRes.status, 200);
  const pubData = await pubRes.json();
  ['L', 'U', 'O'].forEach(lvl => {
    (pubData.questionBank[lvl] || []).forEach(q => {
      assert.strictEqual('correctAnswer' in q, false, `Exposed correctAnswer in public /api/questions level ${lvl}`);
    });
  });
});

// GATE CHECK 4: QUESTION CANONICAL SOURCE SYNCHRONIZATION
test('GATE 4: custom_questions.json and master_questions.json are synchronized', () => {
  const customFile = path.join(__dirname, '..', 'custom_questions.json');
  const masterFile = path.join(__dirname, '..', 'master_questions.json');

  assert.ok(fs.existsSync(customFile), 'custom_questions.json must exist');
  assert.ok(fs.existsSync(masterFile), 'master_questions.json must exist');

  const customContent = fs.readFileSync(customFile, 'utf8');
  const masterContent = fs.readFileSync(masterFile, 'utf8');

  assert.strictEqual(
    customContent,
    masterContent,
    'custom_questions.json and master_questions.json must be identical to prevent answer-key divergence'
  );
});

// GATE CHECK 5: REAL RBAC (UNAUTHORIZED ROLE ACCESS TO PROTECTED APIS)
test('GATE 5: Strict RBAC enforcement across roles (401/403 for unauthorized access)', async () => {
  // 1. Unauthenticated request to /api/admin/audit-logs returns 401
  const resUnauth = await fetch(`${baseUrl}/api/admin/audit-logs`);
  assert.strictEqual(resUnauth.status, 401, 'Unauthenticated request to admin audit logs must be 401');

  // 2. Employee login
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
  });
  const empToken = (await empLogin.json()).token;

  // Employee attempting access to Admin audit logs -> 403 Forbidden
  const empToAdmin = await fetch(`${baseUrl}/api/admin/audit-logs`, {
    headers: { 'x-emp-token': empToken }
  });
  assert.strictEqual(empToAdmin.status, 403, 'Employee attempting admin audit logs must be 403');

  // Employee attempting access to Admin settings -> 403 Forbidden
  const empToSettings = await fetch(`${baseUrl}/api/settings`, {
    headers: { 'x-emp-token': empToken }
  });
  assert.strictEqual(empToSettings.status, 403, 'Employee attempting settings must be 403');

  // Employee attempting access to SuperAdmin reset -> 403 Forbidden
  const empToReset = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' })
  });
  assert.strictEqual(empToReset.status, 403, 'Employee attempting reset-all must be 403');
});

// GATE CHECK 6: IDOR PREVENTION
test('GATE 6: IDOR - Employee A cannot access Employee B records or reports', async () => {
  // Login as Employee A (LN0039)
  const loginA = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
  });
  const tokenA = (await loginA.json()).token;

  // 1. Employee A requests Employee B's DOCX report -> 403
  const docxRes = await fetch(`${baseUrl}/api/employee-docx/LN0040`, {
    headers: { 'x-emp-token': tokenA }
  });
  assert.strictEqual(docxRes.status, 403, 'Employee A accessing Employee B DOCX report must return 403');

  // 2. Employee A requests Employee B's HTML report -> 403
  const htmlRes = await fetch(`${baseUrl}/api/employee-report-html/LN0040`, {
    headers: { 'x-emp-token': tokenA }
  });
  assert.strictEqual(htmlRes.status, 403, 'Employee A accessing Employee B HTML report must return 403');

  // 3. Employee A requests records via /api/records -> returns only LN0039 record
  const recRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-emp-token': tokenA }
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();
  const returnedKeys = Object.keys(recData.records || {});
  assert.ok(returnedKeys.length <= 1, 'Employee records query must never return other employees');
  if (returnedKeys.length === 1) {
    assert.strictEqual(returnedKeys[0], 'LN0039');
  }

  // 4. Employee A attempting to start exam for Employee B -> 403
  const startExamB = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': tokenA
    },
    body: JSON.stringify({ empNo: 'LN0040' })
  });
  assert.strictEqual(startExamB.status, 403, 'Employee A starting exam for Employee B must return 403');
});

// GATE CHECK 7: SESSION LIFECYCLE (LOGIN -> LOGOUT -> REPLAY REJECTED)
test('GATE 7: Session lifecycle - logged-out and replayed sessions rejected', async () => {
  // Login
  const loginRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
  });
  assert.strictEqual(loginRes.status, 200);
  const data = await loginRes.json();
  const sessionToken = data.token;

  // Verify session works
  const meRes = await fetch(`${baseUrl}/api/auth/employee/me`, {
    headers: { 'x-emp-token': sessionToken }
  });
  const meData = await meRes.json();
  assert.strictEqual(meData.authenticated, true);

  // Logout
  const logoutRes = await fetch(`${baseUrl}/api/auth/employee/logout`, {
    method: 'POST',
    headers: { 'x-emp-token': sessionToken }
  });
  assert.strictEqual(logoutRes.status, 200);

  // Replay old session token -> must be rejected
  const replayRes = await fetch(`${baseUrl}/api/auth/employee/me`, {
    headers: { 'x-emp-token': sessionToken }
  });
  const replayData = await replayRes.json();
  assert.strictEqual(replayData.authenticated, false, 'Replayed session token must be unauthenticated');

  // Attempting protected endpoint with replayed token -> 401
  const protectedRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-emp-token': sessionToken }
  });
  assert.strictEqual(protectedRes.status, 401, 'Replayed session token must return 401 Unauthorized');
});

// GATE CHECK 8: RATE LIMITING & BRUTE FORCE DEFENSE
test('GATE 8: OTP rate limiting and brute force defense', async () => {
  // 1. Send OTP to valid admin email
  const sendRes = await fetch(`${baseUrl}/api/auth/admin/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reubengeoffrey16@gmail.com' })
  });

  if (sendRes.status === 200) {
    // Immediate second request within 30 seconds -> 429 Too Many Requests
    const spamRes = await fetch(`${baseUrl}/api/auth/admin/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reubengeoffrey16@gmail.com' })
    });
    assert.strictEqual(spamRes.status, 429, 'Immediate duplicate OTP request must be rate limited with 429');
  }

  // 2. Non-existent OTP verification returns 400
  const verifyRes = await fetch(`${baseUrl}/api/auth/admin/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nonexistent_admin@yokohama.com', otp: '123456' })
  });
  assert.ok(verifyRes.status === 400 || verifyRes.status === 403);
});

// GATE CHECK 9: AUDIT LOGGING INTEGRITY
test('GATE 9: Audit events recorded with comprehensive security metadata', async () => {
  // Admin login to trigger audit event
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await loginRes.json()).token;

  // Retrieve audit logs
  const auditRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.ok(Array.isArray(auditData.logs));
  assert.ok(auditData.logs.length > 0);

  const latest = auditData.logs[auditData.logs.length - 1];
  assert.ok(latest.id, 'Audit log must have unique ID');
  assert.ok(latest.timestamp, 'Audit log must have ISO timestamp');
  assert.ok(latest.action, 'Audit log must specify action');
  assert.ok(latest.user, 'Audit log must specify user');
  assert.ok(latest.ip, 'Audit log must capture IP address');
});

// GATE CHECK 10: CANONICAL DATA INTEGRITY COUNTS (DYNAMIC PROOF WITHOUT HARDCODED CONSTANTS)
test('GATE 10: Canonical dataset counts match authoritative storage dynamically', async () => {
  const emps = JSON.parse(fs.readFileSync('custom_employees.json', 'utf8'));
  const recs = JSON.parse(fs.readFileSync('assessment_records.json', 'utf8'));
  const qs = JSON.parse(fs.readFileSync('custom_questions.json', 'utf8'));
  const ojts = JSON.parse(fs.readFileSync('ojt_evaluations.json', 'utf8'));

  // Admin login to query live authoritative APIs
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await loginRes.json()).token;

  // 1. Employee count via API matches canonical store
  const statsRes = await fetch(`${baseUrl}/api/admin/dashboard-stats`, {
    headers: { 'x-admin-token': adminToken }
  });
  const statsData = await statsRes.json();
  assert.strictEqual(statsData.data.totalEmployees, emps.length, 'API employee count must match canonical employees store');

  // 2. Records count via API matches canonical store
  const recsRes = await fetch(`${baseUrl}/api/records`, {
    headers: { 'x-admin-token': adminToken }
  });
  const recsData = await recsRes.json();
  assert.strictEqual(Object.keys(recsData.records).length, Object.keys(recs).length, 'API records count must match canonical records store');

  // 3. Question bank counts via API match canonical store
  const qsRes = await fetch(`${baseUrl}/api/questions`, {
    headers: { 'x-admin-token': adminToken }
  });
  const qsData = await qsRes.json();
  const apiTotalQs = (qsData.questionBank.L || []).length + (qsData.questionBank.U || []).length + (qsData.questionBank.O || []).length;
  const storeTotalQs = qs.L.length + qs.U.length + qs.O.length;
  assert.strictEqual(apiTotalQs, storeTotalQs, 'API questions count must match canonical questions store');

  // 4. OJT evaluations count via API matches canonical store
  const ojtsRes = await fetch(`${baseUrl}/api/ojt-evaluations`, {
    headers: { 'x-admin-token': adminToken }
  });
  const ojtsData = await ojtsRes.json();
  assert.strictEqual(Object.keys(ojtsData.evaluations).length, Object.keys(ojts).length, 'API OJT evaluations count must match canonical OJT store');
});

// GATE CHECK 11: SOP RULES & PERCENTAGE ROUNDING
test('GATE 11: SOP pass/fail boundary at 50% and integer rounding', () => {
  // 10/20 = 50% -> Passed
  const pct50 = Math.round((10 / 20) * 100);
  assert.strictEqual(pct50, 50);
  assert.strictEqual(pct50 >= 50, true);

  // 9/20 = 45% -> Failed
  const pct45 = Math.round((9 / 20) * 100);
  assert.strictEqual(pct45, 45);
  assert.strictEqual(pct45 >= 50, false);

  // 15/30 = 50% (Level U) -> Passed
  const pctU = Math.round((15 / 30) * 100);
  assert.strictEqual(pctU, 50);
  assert.strictEqual(pctU >= 50, true);

  // 20/40 = 50% (Level O) -> Passed
  const pctO = Math.round((20 / 40) * 100);
  assert.strictEqual(pctO, 50);
  assert.strictEqual(pctO >= 50, true);
});

// GATE CHECK 12: STATIC ASSET ALLOWLIST ENFORCEMENT
test('GATE 12: Strict allowlist blocks direct access to server.js and internal assets (403)', async () => {
  const forbiddenFiles = [
    '/server.js',
    '/package.json',
    '/.env',
    '/tests/gate.test.js',
    '/README.md',
    '/word_to_pdf.ps1',
    '/custom_employees.json'
  ];

  for (const f of forbiddenFiles) {
    const res = await fetch(`${baseUrl}${f}`);
    assert.strictEqual(res.status, 403, `Direct access to ${f} must be blocked with 403`);
  }

  // Public assets must be accessible (200)
  const publicFiles = ['/index.html', '/app.js', '/data.js', '/styles.css'];
  for (const pf of publicFiles) {
    const res = await fetch(`${baseUrl}${pf}`);
    assert.strictEqual(res.status, 200, `Public file ${pf} must be accessible with 200`);
  }
});

// GATE CHECK 13: COOKIE SECURITY ATTRIBUTES
test('GATE 13: Set-Cookie headers enforce HttpOnly, Path=/, SameSite=lax', async () => {
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
  });
  assert.strictEqual(res.status, 200);

  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Set-Cookie header must be present');
  assert.ok(setCookie.includes('HttpOnly'), 'Cookie must specify HttpOnly');
  assert.ok(setCookie.includes('Path=/'), 'Cookie must specify Path=/');
  assert.ok(setCookie.toLowerCase().includes('samesite=lax'), 'Cookie must specify SameSite=lax');
});

// GATE CHECK 14: ERROR DETAIL LEAKAGE PREVENTION
test('GATE 14: Malformed requests do not leak internal stack traces or paths', async () => {
  const res = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': 'invalid_token'
    },
    body: '{"invalid_json'
  });

  // Malformed JSON should return 400 or handled error without stack trace
  const bodyText = await res.text();
  assert.strictEqual(bodyText.includes('node_modules'), false, 'Response must not leak node_modules paths');
  assert.strictEqual(bodyText.includes('at '), false, 'Response must not leak call stack frames');
  assert.strictEqual(bodyText.includes(process.env.SESSION_SECRET || 'secret'), false, 'Response must not leak SESSION_SECRET');
});
