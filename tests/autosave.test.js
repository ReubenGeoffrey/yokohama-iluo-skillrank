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

  // Login directly with employee number as credential
  const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900262', password: '900262' })
  });
  const data = await res.json();
  empToken = data.token;
  assert.ok(empToken, 'Login must yield a valid token');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// TEST 1: Exam start -> Autosave partial answers -> Resume session
test('AUTOSAVE 1: Partial responses autosave periodically and resume upon reconnection', async () => {
  // 1. Start exam
  const startRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: '900262', targetLevel: 'L', forceRetake: true })
  });
  assert.strictEqual(startRes.status, 200);
  const startData = await startRes.json();
  assert.strictEqual(startData.success, true);
  assert.strictEqual(startData.isResumed, undefined);
  assert.ok(startData.activeExam.questions.length > 0);

  const firstQ = startData.activeExam.questions[0];

  // 2. Autosave answer for Q1 and progress to Q2 (index 1)
  const autosaveRes = await fetch(`${baseUrl}/api/exam/autosave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({
      empNo: '900262',
      responses: { [firstQ.id]: 'B' },
      currentIndex: 1,
      tabSwitchCount: 0
    })
  });
  assert.strictEqual(autosaveRes.status, 200);
  const autosaveData = await autosaveRes.json();
  assert.strictEqual(autosaveData.success, true);
  assert.ok(typeof autosaveData.remainingSeconds === 'number');

  // 3. Simulate candidate page refresh / reconnect: call start without forceRetake
  const resumeRes = await fetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: '900262' })
  });
  assert.strictEqual(resumeRes.status, 200);
  const resumeData = await resumeRes.json();
  assert.strictEqual(resumeData.success, true);
  assert.strictEqual(resumeData.isResumed, true, 'Resume response indicates active session continuation');
  assert.strictEqual(resumeData.activeExam.currentIndex, 1, 'Current question index restored');
  assert.strictEqual(resumeData.activeExam.responses[firstQ.id], 'B', 'Previously saved answer restored');
  assert.ok(resumeData.activeExam.remainingSeconds > 0, 'Server-authoritative timer remaining returned');
});

// TEST 2: Tab switch violation limit triggers automatic submission (Task 2.7)
test('AUTOSAVE 2: Exceeding 3 tab switches automatically terminates and scores exam', async () => {
  // Candidate commits 3rd tab switch
  const autoTermRes = await fetch(`${baseUrl}/api/exam/autosave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({
      empNo: '900262',
      responses: {},
      currentIndex: 2,
      tabSwitchCount: 3
    })
  });

  assert.strictEqual(autoTermRes.status, 200);
  const autoTermData = await autoTermRes.json();
  assert.strictEqual(autoTermData.success, true);
  assert.strictEqual(autoTermData.autoSubmitted, true);
  assert.strictEqual(autoTermData.record.isCompleted, true);
  assert.strictEqual(autoTermData.record.autoSubmitReason, 'EXCEEDED_TAB_SWITCH_LIMIT');

  // Attempting to autosave again is rejected (exam completed)
  const deadAutosave = await fetch(`${baseUrl}/api/exam/autosave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-emp-token': empToken
    },
    body: JSON.stringify({ empNo: '900262', responses: {} })
  });
  assert.strictEqual(deadAutosave.status, 404);
});
