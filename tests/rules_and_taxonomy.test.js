const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server.js');

let server;
let baseUrl;
let empToken;

async function makeRequest(method, pathStr, body = null, headers = {}) {
  const url = new URL(pathStr, baseUrl);
  const opts = {
    method,
    headers: Object.assign({}, headers)
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('SETUP: Start test server and authenticate employee', async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;

  // Log in as employee LN0039
  const loginRes = await makeRequest('POST', '/api/auth/employee/login', {
    empNo: 'LN0039',
    password: 'LN0039'
  });
  assert.strictEqual(loginRes.status, 200);
  empToken = loginRes.data.token;
  assert.ok(empToken);
});

test('RULES 1: Pure transition-based eligibility edge cases (Task 2.12 / B1)', () => {
  const calc = app._calculateEligibleLevel;
  assert.ok(typeof calc === 'function', 'calculateEligibleLevel must be exported');

  // Format today's date minus days/months
  function getDateAgo(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
  }

  // 1. Level I is always eligible for L (regardless of days)
  assert.strictEqual(calc('I', getDateAgo(0)), 'L', 'Day 0 should be eligible for L');
  assert.strictEqual(calc('I', getDateAgo(7)), 'L', '7 days should be eligible for L');
  assert.strictEqual(calc('I', getDateAgo(30)), 'L', '30 days should be eligible for L');

  // 2. Level L transition to U requires min 6 months
  assert.strictEqual(calc('L', getDateAgo(30)), 'L', '1 month should remain L');
  assert.strictEqual(calc('L', getDateAgo(90)), 'L', '90 days (3 months) should remain L (min 6m needed)');
  assert.strictEqual(calc('L', getDateAgo(150)), 'L', '5 months should remain L');
  assert.strictEqual(calc('L', getDateAgo(185)), 'U', '6+ months should become eligible for U');

  // 3. Level U transition to O requires default 24 months (no overlapping ranges)
  assert.strictEqual(calc('U', getDateAgo(200)), 'U', '6.5 months should remain U');
  assert.strictEqual(calc('U', getDateAgo(365)), 'U', '12 months should remain U');
  assert.strictEqual(calc('U', getDateAgo(700)), 'U', '23 months should remain U');
  assert.strictEqual(calc('U', getDateAgo(740)), 'O', '24+ months should become eligible for O');

  // 4. Level O stays Level O
  assert.strictEqual(calc('O', getDateAgo(1000)), 'O', 'Level O remains O');
});

test('RULES 2: Single configuration source for tiered standards (Task 2.12 / B2)', async () => {
  const res = await makeRequest('GET', '/api/config/assessment-standards');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.status, 'ACTIVE_PENDING_HR_CONFIRMATION');

  const standards = res.data.standards;
  assert.strictEqual(standards.passMarks.L, 50, 'Level L pass mark must be 50%');
  assert.strictEqual(standards.passMarks.U, 60, 'Level U pass mark must be 60%');
  assert.strictEqual(standards.passMarks.O, 75, 'Level O pass mark must be 75%');
  assert.strictEqual(standards.ojtPassPct, 70, 'OJT pass mark must be 70%');
  assert.strictEqual(standards.transitionMonths['U->O'], 24, 'Default U->O transition must be 24m');
});

test('RULES 3: Standalone Manufacturing Foundation Module (Task 2.13 / B8)', async () => {
  // 1. Start Foundation Exam
  const startRes = await makeRequest('POST', '/api/exam/start', {
    empNo: 'LN0039',
    targetLevel: 'FOUNDATION',
    forceRetake: true
  }, { 'x-emp-token': empToken });

  assert.strictEqual(startRes.status, 200);
  assert.strictEqual(startRes.data.success, true);
  const exam = startRes.data.activeExam;
  assert.strictEqual(exam.targetLevel, 'FOUNDATION');
  assert.strictEqual(exam.questions.length, 20, 'Foundation module should consist of 20 questions');

  // 2. Submit passing responses
  const answers = {};
  exam.questions.forEach(q => { answers[q.id] = 'A'; });

  const submitRes = await makeRequest('POST', '/api/exam/submit', {
    empNo: 'LN0039',
    targetLevel: 'FOUNDATION',
    responses: answers
  }, { 'x-emp-token': empToken });

  assert.strictEqual(submitRes.status, 200);
  assert.strictEqual(submitRes.data.success, true);
  assert.strictEqual(submitRes.data.record.isFoundation, true, 'Record must be flagged isFoundation: true');
  assert.strictEqual(submitRes.data.record.moduleName, 'Manufacturing Foundation Module');

  // 3. Verify Foundation module NEVER alters candidate currentLevel
  const meRes = await makeRequest('GET', '/api/auth/employee/me', null, { 'x-emp-token': empToken });
  assert.strictEqual(meRes.status, 200);
  assert.strictEqual(meRes.data.employee.currentLevel, 'I', 'Candidate skill level must NOT change after foundation exam');
});

test('RULES 4: Locked level exams for sections without uploaded question bank (Task 2.13 / B8)', async () => {
  // Log in as production employee 901128 (section: MIXING)
  const prodLogin = await makeRequest('POST', '/api/auth/employee/login', {
    empNo: '901128',
    password: 'password123'
  });
  const prodToken = prodLogin.data && prodLogin.data.token ? prodLogin.data.token : (
    (await makeRequest('POST', '/api/auth/employee/login', { empNo: '901128', password: '901128' })).data.token
  );
  assert.ok(prodToken, 'Must authenticate production employee 901128');

  // Attempt to start a level exam for an unprovisioned Production section (MIXING)
  const lockedRes = await makeRequest('POST', '/api/exam/start', {
    empNo: '901128',
    targetLevel: 'O',
    forceRetake: true
  }, { 'x-emp-token': prodToken });

  assert.strictEqual(lockedRes.status, 403);
  assert.strictEqual(lockedRes.data.locked, true);
  assert.ok(lockedRes.data.message.includes('locked until a section question bank is uploaded'));
});

test('TAXONOMY 1: Canonical 33-section plant taxonomy and normalization (Task 2.14)', async () => {
  const res = await makeRequest('GET', '/api/taxonomy/sections');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.totalSections, 33, 'Total plant sections must equal 33');
  assert.strictEqual(res.data.qaCount, 8, 'QA sections must equal 8');
  assert.strictEqual(res.data.productionCount, 25, 'Production sections must equal 25');

  const taxonomy = app._CANONICAL_PLANT_SECTIONS;
  assert.strictEqual(taxonomy.qa.length, 8);
  assert.strictEqual(taxonomy.production.length, 25);
});

test('TEARDOWN: Stop test server', async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});
