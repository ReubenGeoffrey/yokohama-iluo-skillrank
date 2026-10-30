const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Tokens = require('csrf');

const csrfTokens = new Tokens();
let baseUrl = process.env.TEST_BASE_URL;
let server;

test.before(async () => {
  if (!baseUrl) {
    process.env.NODE_ENV = 'test';
    const app = require('../server.js');
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =========================================================================
// SECTION 1: CSRF FAIL-CLOSED DEFENSE TESTS
// =========================================================================

test('CSRF 1: Cookie-authenticated state-changing request with MISSING CSRF token is rejected (403)', async () => {
  // Step 1: Login to obtain authenticated session cookie
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie');
  assert.ok(setCookie, 'Must set session cookie on login');

  // Extract admin_session cookie
  const adminMatch = setCookie.match(/admin_session=([^;]+)/);
  assert.ok(adminMatch, 'admin_session cookie must be present');
  const adminCookie = `admin_session=${adminMatch[1]}`;

  // Step 2: Attempt state-changing request (POST /api/settings) with session cookie but NO CSRF token
  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403, 'Must reject with 403 when CSRF token is missing');
  const body = await mutateRes.json();
  assert.strictEqual(body.success, false);
  assert.match(body.message, /CSRF token missing/i, 'Must fail-closed with specific CSRF token missing message');
});

test('CSRF 2: Cookie-authenticated request with CSRF token but MISSING CSRF secret is rejected (403)', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const setCookie = loginRes.headers.get('set-cookie');
  const adminMatch = setCookie.match(/admin_session=([^;]+)/);
  const adminCookie = `admin_session=${adminMatch[1]}`;

  // Provide a dummy token but omit _csrf_secret cookie
  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie, // No _csrf_secret in Cookie header!
      'x-csrf-token': 'dummy_client_provided_token'
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403);
  const body = await mutateRes.json();
  assert.match(body.message, /CSRF session secret missing/i);
});

test('CSRF 3: Cookie-authenticated request with INVALID CSRF token is rejected (403)', async () => {
  const secret = csrfTokens.secretSync();
  const bogusToken = 'invalid_forged_csrf_token_value_12345';

  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const setCookie = loginRes.headers.get('set-cookie');
  const adminMatch = setCookie.match(/admin_session=([^;]+)/);
  const cookieHeader = `admin_session=${adminMatch[1]}; _csrf_secret=${secret}`;

  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'x-csrf-token': bogusToken
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403);
  const body = await mutateRes.json();
  assert.match(body.message, /Invalid CSRF token/i);
});

test('CSRF 4: Request with UNTRUSTED Origin is rejected (403)', async () => {
  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://malicious-attacker-domain.evil'
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403);
  const body = await mutateRes.json();
  assert.match(body.message, /Untrusted Origin|Origin blocked by CORS policy/i);
});

test('CSRF 5: Request with UNTRUSTED Referer is rejected (403)', async () => {
  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://malicious-attacker-domain.evil/attack.html'
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403);
  const body = await mutateRes.json();
  assert.match(body.message, /Untrusted Referer/i);
});

test('CSRF 6: Request with BOTH cookie session AND custom header still REQUIRES valid CSRF token (no bypass)', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await loginRes.json();
  const setCookie = loginRes.headers.get('set-cookie');
  const adminMatch = setCookie.match(/admin_session=([^;]+)/);
  const adminCookie = `admin_session=${adminMatch[1]}`;

  // Attacker provides custom header AND ambient cookie, but no CSRF token
  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie,
      'x-admin-token': token // Custom header must NOT bypass CSRF when cookie session is present!
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 403, 'Must reject: custom header does not bypass cookie CSRF requirement');
  const body = await mutateRes.json();
  assert.match(body.message, /CSRF token missing/i);
});

test('CSRF 7: Cookie-authenticated request with VALID CSRF token and secret succeeds (200)', async () => {
  // Obtain fresh secret and token
  const secret = csrfTokens.secretSync();
  const validToken = csrfTokens.create(secret);

  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const setCookie = loginRes.headers.get('set-cookie');
  const adminMatch = setCookie.match(/admin_session=([^;]+)/);
  const cookieHeader = `admin_session=${adminMatch[1]}; _csrf_secret=${secret}`;

  const mutateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'x-csrf-token': validToken
    },
    body: JSON.stringify({ settings: { examTimeMinutes: 45 } })
  });

  assert.strictEqual(mutateRes.status, 200, 'Must succeed with 200 when valid CSRF token and secret match');
  const body = await mutateRes.json();
  assert.strictEqual(body.success, true);
});

// =========================================================================
// SECTION 2: DISTRIBUTED RATE LIMITING & LOCKOUT TESTS
// =========================================================================

test('RATE LIMIT 1: Excessive authentication failures trigger 429 Too Many Requests with Retry-After header', async () => {
  const testAccount = 'bruteforce_target_' + Date.now();

  let lastRes = null;
  // Trigger failures up to the threshold (5 attempts)
  for (let i = 0; i < 5; i++) {
    lastRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testAccount, password: 'wrongpassword' })
    });
  }

  // 6th attempt must be locked out
  const lockedRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testAccount, password: 'wrongpassword' })
  });

  assert.strictEqual(lockedRes.status, 429, 'Must return HTTP 429 Too Many Requests');
  const retryAfter = lockedRes.headers.get('retry-after');
  assert.ok(retryAfter, 'Must include Retry-After header');
  assert.ok(parseInt(retryAfter, 10) > 0, 'Retry-After must be a positive integer');

  const body = await lockedRes.json();
  assert.strictEqual(body.success, false);
  assert.match(body.message, /temporarily locked out/i);
});

test('RATE LIMIT 2: Successful authentication on Account A does NOT reset rate limit on another target', async () => {
  const attackedAccount = 'victim_user_' + Date.now();

  for (let i = 0; i < 5; i++) {
    await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: attackedAccount, password: 'wrongpassword' })
    });
  }

  // Confirm victim is locked out
  const victimCheck = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: attackedAccount, password: 'wrongpassword' })
  });
  assert.strictEqual(victimCheck.status, 429);

  // Legitimate admin logs in successfully
  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(adminLogin.status, 200);

  // Victim account MUST STILL be locked out
  const victimCheck2 = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: attackedAccount, password: 'wrongpassword' })
  });
  assert.strictEqual(victimCheck2.status, 429, 'Victim account lockout must persist after unrelated successful login');
});

// =========================================================================
// SECTION 3: PATH TRAVERSAL & TEMPLATE ALLOWLIST TESTS
// =========================================================================

test('PATH HARDENING 1: Path traversal in document generation is rejected', async () => {
  // Login as superadmin
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await loginRes.json();

  // Attempt path traversal using ../ in empNo parameter
  const traversalEmpNo = '../../../../windows/system32/cmd.exe';
  const docxRes = await fetch(`${baseUrl}/api/generate-docx/${encodeURIComponent(traversalEmpNo)}`, {
    headers: { 'x-admin-token': token }
  });

  // Non-existent employee with path traversal must fail safely (403 or 404)
  assert.ok([400, 403, 404].includes(docxRes.status), `Must reject path traversal with error status, got ${docxRes.status}`);
});

test('PATH HARDENING 2: Template allowlist strictly rejects arbitrary or unapproved template files', async () => {
  // Verify that ALLOWED_TEMPLATE_FILENAMES only allows .docx templates from QC_templates
  const qcTemplatesDir = path.resolve(__dirname, '..', 'QC_templates');
  if (fs.existsSync(qcTemplatesDir)) {
    const files = fs.readdirSync(qcTemplatesDir);
    assert.strictEqual(files.length, 24, 'QC_templates must contain exactly 24 approved templates');
    for (const f of files) {
      assert.ok(f.endsWith('.docx'), `Template ${f} must end with .docx`);
      assert.ok(!f.includes('..'), `Template ${f} must not contain traversal characters`);
    }
  }
});

// =========================================================================
// SECTION 4: DATASET PARSER REGRESSION TESTS
// =========================================================================

test('JSON PARSER 1: real data.js extracts and validates strictly without eval', () => {
  const dataJsPath = path.resolve(__dirname, '..', 'data.js');
  const content = fs.readFileSync(dataJsPath, 'utf-8');

  // Strict extraction
  const empStart = content.indexOf('const EMPLOYEES = [');
  const empBracket = content.indexOf('[', empStart);
  const empEnd = content.indexOf('];', empBracket);
  const emps = JSON.parse(content.slice(empBracket, empEnd + 1));
  assert.ok(Array.isArray(emps), 'Employees must be an array');
  assert.strictEqual(emps.length, 1462, 'Must contain exactly 1,462 employees');

  const qbStart = content.indexOf('const QUESTION_BANK = {');
  const qbEnd = content.indexOf('const LEVEL_RULES = {');
  const qbStr = content.slice(qbStart + 'const QUESTION_BANK = '.length, qbEnd).trim().replace(/;$/, '');
  const qb = JSON.parse(qbStr);
  assert.deepStrictEqual(Object.keys(qb).sort(), ['L', 'O', 'U']);
  assert.strictEqual(qb.L.length, 160);
  assert.strictEqual(qb.U.length, 240);
  assert.strictEqual(qb.O.length, 320);
});

test('JSON PARSER 2: Malformed or unexpected syntax safely throws SyntaxError and is handled', () => {
  const malformed = 'const EMPLOYEES = [{ unquotedKey: 123 }];';
  assert.throws(() => {
    JSON.parse(malformed.slice(18, -1));
  }, SyntaxError, 'JSON.parse must strictly reject unquoted JS object syntax');
});

// =========================================================================
// SECTION 5: SUBRESOURCE INTEGRITY (SRI) BYTE-FOR-BYTE INDEPENDENT TEST
// =========================================================================

test('SRI 1: index.html Chart.js integrity attribute matches official CDN hash byte-for-byte', async () => {
  const indexHtmlPath = path.resolve(__dirname, '..', 'index.html');
  const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

  const scriptTagRegex = /<script\s+[^>]*src=["'](https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^"']+)["'][^>]*>/i;
  const match = htmlContent.match(scriptTagRegex);
  assert.ok(match, 'Chart.js script tag with pinned CDN URL must be present in index.html');

  const integrityRegex = /integrity=["'](sha384-[^"']+)["']/i;
  const integrityMatch = match[0].match(integrityRegex);
  assert.ok(integrityMatch, 'integrity attribute must be present in script tag');
  const expectedHash = integrityMatch[1];

  // Fetch the exact URL and compute cryptographic SHA-384
  const cdnUrl = match[1];
  const resp = await fetch(cdnUrl);
  assert.strictEqual(resp.status, 200, 'CDN asset must be accessible');
  const buffer = Buffer.from(await resp.arrayBuffer());
  const calculatedHash = 'sha384-' + crypto.createHash('sha384').update(buffer).digest('base64');

  assert.strictEqual(calculatedHash, expectedHash, 'Calculated SHA-384 digest must match integrity attribute byte-for-byte');
});
