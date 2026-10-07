const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
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

  // Authenticate as test employee
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'LN0039', password: '1234' })
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
