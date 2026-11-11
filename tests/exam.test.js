const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
process.env.NODE_ENV = 'test';
const app = require('../server.js');

let server;
let baseUrl;
let empToken;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Setup password first
  await fetch(`${baseUrl}/api/auth/employee/setup-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', doj: '2023-12-13', newPassword: 'Emp@Secure2026!' })
  });

  // Authenticate as test employee
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: 'Emp@Secure2026!' })
  });
  const data = await res.json();
  empToken = data.token;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/exam/start returns sanitized questions with no correct answers', async () => {
  const res = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: 'LN0039', targetLevel: 'L', forceRetake: true })
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.activeExam);
  assert.ok(Array.isArray(data.activeExam.questions));
  assert.strictEqual(data.activeExam.questions.length, 20);

  // Verify none have correctAnswer exposed
  data.activeExam.questions.forEach(q => {
    assert.strictEqual(q.correctAnswer, undefined, `Exam question ${q.id} must not leak correctAnswer`);
    assert.ok(Array.isArray(q.options));
    assert.ok(q.options.length >= 2);
  });
});

test('POST /api/exam/submit evaluates score authoritatively on server', async () => {
  // Submit sample answers for LN0039
  const res = await fetch(`${baseUrl}/api/exam/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({
      empNo: 'LN0039',
      targetLevel: 'L',
      responses: {
        'L_Warehouse_QA_1': 'D', // Correct
        'L_Warehouse_QA_2': 'B', // Correct
        'L_Warehouse_QA_3': 'A'  // Correct
      }
    })
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.record);
  assert.strictEqual(data.record.isCompleted, true);
  assert.strictEqual(data.record.empNo, 'LN0039');
  assert.ok(typeof data.record.totalMark === 'number');
  assert.ok(typeof data.record.markPct === 'number');
  assert.ok(typeof data.record.safetyMark === 'number');
  assert.ok(typeof data.record.safetyTotal === 'number');
  assert.ok(['Passed', 'Failed'].includes(data.record.status));
});

test('Duplicate exam submission is rejected (409 Conflict)', async () => {
  const res = await fetch(`${baseUrl}/api/exam/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({
      empNo: 'LN0039',
      targetLevel: 'L',
      responses: {}
    })
  });

  assert.strictEqual(res.status, 409);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});

// TEST: Pool Capacity & Shortfall Audit (Task 2.5 / S6)
test('GET /api/admin/questions/capacity calculates pool capacity and flags single-paper shortfall', async () => {
  // 1. Authenticate as Admin
  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(adminLogin.status, 200);
  const { token: adminToken } = await adminLogin.json();

  // 2. Query question capacity
  const capRes = await fetch(`${baseUrl}/api/admin/questions/capacity`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(capRes.status, 200);
  const capData = await capRes.json();
  assert.strictEqual(capData.success, true);
  assert.ok(capData.capacity);
  assert.ok(capData.capacity.totalQuestions >= 720, 'Authoritative pool has at least 720 questions');
  assert.strictEqual(capData.capacity.hasShortfall, true, 'Flags single-paper shortfall across sections');
  assert.ok(capData.capacity.shortfallSections.length > 0);
  assert.ok(capData.capacity.auditWarning.includes('CAPACITY AUDIT NOTICE'));
});

// TEST: Candidate Option Randomization (Task 2.5 / S6)
test('POST /api/exam/start randomizes candidate options while maintaining canonical keys', async () => {
  const res = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: 'LN0039', targetLevel: 'L', forceRetake: true })
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.activeExam.questions.length > 0);

  // Assert all options have valid non-empty keys and text
  for (const q of data.activeExam.questions) {
    const keys = q.options.map(o => o.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'Option keys must be distinct');
    assert.strictEqual('correctAnswer' in q, false, 'Correct answer must never be exposed');
  }
});

