const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
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

test('Direct file access to internal files (.json, .env, .md) is blocked (403 Forbidden)', async () => {
  const sensitiveFiles = [
    '/custom_questions.json',
    '/assessment_records.json',
    '/package.json',
    '/.env',
    '/README.md'
  ];

  for (const file of sensitiveFiles) {
    const res = await fetch(`${baseUrl}${file}`);
    assert.strictEqual(res.status, 403, `Expected 403 Forbidden for ${file}, got ${res.status}`);
  }
});

test('GET /api/questions strips correctAnswer for unauthenticated clients', async () => {
  const res = await fetch(`${baseUrl}/api/questions`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.questionBank);

  ['L', 'U', 'O'].forEach(level => {
    const questions = data.questionBank[level] || [];
    assert.ok(questions.length > 0, `Expected questions in level ${level}`);
    questions.forEach(q => {
      assert.strictEqual(q.correctAnswer, undefined, `Found exposed correctAnswer in question ${q.id}`);
    });
  });
});

test('Static data.js contains zero correctAnswer properties', () => {
  const content = fs.readFileSync('data.js', 'utf8');
  assert.strictEqual(content.includes('correctAnswer'), false, 'data.js must not contain any correctAnswer properties');
});

test('CSRF protection blocks state-changing requests from untrusted origins', async () => {
  const res = await fetch(`${baseUrl}/api/auth/evaluator/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://malicious-attacker-website.com'
    },
    body: JSON.stringify({ section: 'Safety', password: 'safety123' })
  });

  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});

test('POST /api/auth/admin/send-otp rejects unauthorized email addresses', async () => {
  const res = await fetch(`${baseUrl}/api/auth/admin/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hacker@unauthorized-domain.com' })
  });
  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});
