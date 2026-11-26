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

  // Authenticate as test employee directly with Employee Number as default password
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: 'LN0039' })
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

test('After complete zero-finish reset, attending exam stores only the new record without resurrecting seeds', async () => {
  const adminRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await adminRes.json()).token;

  // 1. Reset all exam records & OJT evaluations to 0 finished
  const resetExams = await fetch(`${baseUrl}/api/records/reset-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-EXAMS' })
  });
  assert.strictEqual(resetExams.status, 200);

  const resetOjt = await fetch(`${baseUrl}/api/ojt-evaluations/reset-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify({ confirmPhrase: 'RESET-ALL-OJT' })
  });
  assert.strictEqual(resetOjt.status, 200);

  // Confirm 0 records & 0 OJT
  const emptyRecs = await (await fetch(`${baseUrl}/api/records`, { headers: { 'x-admin-token': adminToken } })).json();
  assert.strictEqual(Object.keys(emptyRecs.records).length, 0);

  // 2. Employee attends and submits exam
  const startRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-emp-token': empToken },
    body: JSON.stringify({ empNo: 'LN0039', targetLevel: 'L', forceRetake: true })
  });
  assert.strictEqual(startRes.status, 200);

  const subRes = await fetch(`${baseUrl}/api/exam/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-emp-token': empToken },
    body: JSON.stringify({
      empNo: 'LN0039',
      targetLevel: 'L',
      responses: { 'L_Warehouse_QA_1': 'D', 'L_Warehouse_QA_2': 'B' }
    })
  });
  assert.strictEqual(subRes.status, 200);

  // 3. Admin queries /api/records -> strictly 1 finished record stored, 0 resurrected seeds
  const afterRecs = await (await fetch(`${baseUrl}/api/records`, { headers: { 'x-admin-token': adminToken } })).json();
  assert.strictEqual(Object.keys(afterRecs.records).length, 1);
  assert.strictEqual(afterRecs.records['LN0039'].isCompleted, true);
});
