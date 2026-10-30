const test = require('node:test');
const assert = require('node:assert');
// Load authoritative app
const app = require('../server.js');

let server;
let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
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

test('ATOMIC LUA SCRIPT: Verifies script structure and operations', async () => {
  assert.ok(app.LUA_ATOMIC_RATE_LIMIT, 'LUA_ATOMIC_RATE_LIMIT must be exported');
  assert.ok(app.LUA_ATOMIC_RATE_LIMIT.includes("redis.call('INCR', KEYS[1])"), 'Script must atomically INCR counter');
  assert.ok(app.LUA_ATOMIC_RATE_LIMIT.includes("redis.call('EXPIRE', KEYS[1], ARGV[1])"), 'Script must atomically set EXPIRE');
  assert.ok(app.LUA_ATOMIC_RATE_LIMIT.includes("redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])"), 'Script must atomically set lockout with TTL');
  assert.ok(app.LUA_ATOMIC_RATE_LIMIT.includes("redis.call('DEL', KEYS[1])"), 'Script must delete counter upon reaching threshold');
});

test('RATE LIMIT: First counter creation and existing counter progression in memory fallback', async () => {
  app.resetRateLimitMemory();
  const testKey = 'test_unit_' + Date.now();

  // First failure: counter created
  let lockSec = await app.recordRateFailureOnKey(testKey, 3, 60, 120);
  assert.strictEqual(lockSec, 0, 'First failure should not trigger lockout');

  // Second failure
  lockSec = await app.recordRateFailureOnKey(testKey, 3, 60, 120);
  assert.strictEqual(lockSec, 0, 'Second failure should not trigger lockout');

  // Third failure: threshold reached (3/3), lock triggered
  lockSec = await app.recordRateFailureOnKey(testKey, 3, 60, 120);
  assert.strictEqual(lockSec, 120, 'Third failure should trigger 120s lockout');

  // Check isRateKeyLocked returns positive remaining time
  const remaining = await app.isRateKeyLocked(testKey);
  assert.ok(remaining > 0 && remaining <= 120, `Remaining lock time should be > 0, got ${remaining}`);
});

test('ACCOUNT & IP ISOLATION: Account A lockout does NOT lock Account B', async () => {
  app.resetRateLimitMemory();
  const acctA = 'acc:candidate_alpha_' + Date.now();
  const acctB = 'acc:candidate_beta_' + Date.now();

  // Lock Account A
  await app.recordRateFailureOnKey(acctA, 2, 60, 300);
  await app.recordRateFailureOnKey(acctA, 2, 60, 300);

  const lockA = await app.isRateKeyLocked(acctA);
  const lockB = await app.isRateKeyLocked(acctB);

  assert.ok(lockA > 0, 'Account A must be locked');
  assert.strictEqual(lockB, 0, 'Account B must remain completely unlocked');
});

test('ACCOUNT ISOLATION: Successful login resets only account counter, not IP counter', async () => {
  app.resetRateLimitMemory();
  const ipKey = 'ip:192.168.1.100';
  const acctKey = 'acc:user_isolation_' + Date.now();

  // Record 1 failure for IP and Account
  await app.recordRateFailureOnKey(ipKey, 20, 600, 900);
  await app.recordRateFailureOnKey(acctKey, 5, 600, 900);

  // Clear account success
  await app.clearRateAccountSuccess(acctKey);

  // Account should be clean
  const accLocked = await app.isRateKeyLocked(acctKey);
  assert.strictEqual(accLocked, 0, 'Account lockout must be cleared');

  // Next account failure starts at attempt 1, while IP failure counter remains
  const lockAcc = await app.recordRateFailureOnKey(acctKey, 5, 600, 900);
  assert.strictEqual(lockAcc, 0, 'Account attempt 1 should not lock');
});

test('CONCURRENT REQUESTS: Multiple parallel failures serialize without race condition', async () => {
  app.resetRateLimitMemory();
  const testKey = 'concurrent_test_' + Date.now();

  // Dispatch 5 concurrent failure recordings with threshold 5
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(app.recordRateFailureOnKey(testKey, 5, 60, 300));
  }
  const results = await Promise.all(promises);

  // Exactly one of the calls triggers the lockout (returns 300)
  const lockouts = results.filter((r) => r === 300);
  assert.strictEqual(lockouts.length, 1, 'Exactly one concurrent call should trigger the lockout');

  // Key should now be locked
  const isLocked = await app.isRateKeyLocked(testKey);
  assert.ok(isLocked > 0, 'Key must be locked after 5 concurrent requests');
});

test('PRODUCTION FAIL-CLOSED: Rejects login with HTTP 503 when Redis write is forbidden', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  app.setKvWriteForbidden(true); // Simulate NOPERM or Read-Only token in production

  try {
    const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: '999999', password: 'wrong' })
    });

    assert.strictEqual(res.status, 503, `Production must reject with 503 when Redis is unavailable, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
    assert.ok(data.message.includes('unavailable'), 'Should describe service unavailable');
  } finally {
    process.env.NODE_ENV = originalEnv;
    app.setKvWriteForbidden(false);
  }
});

test('DEVELOPMENT FALLBACK: Retains in-memory fallback with HTTP 401 when NODE_ENV is not production', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  app.setKvWriteForbidden(true); // Simulate Redis write forbidden

  try {
    const res = await fetch(`${baseUrl}/api/auth/employee/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: '999999', password: 'wrong' })
    });

    assert.strictEqual(res.status, 401, `Development must fall back to memory and return 401, got ${res.status}`);
  } finally {
    process.env.NODE_ENV = originalEnv;
    app.setKvWriteForbidden(false);
  }
});

test('LOCK EXPIRATION: Key automatically unlocks after timeout expires', async () => {
  app.resetRateLimitMemory();
  const testKey = 'expiring_key_' + Date.now();

  // Lock for 1 second
  await app.recordRateFailureOnKey(testKey, 1, 10, 1);
  let isLocked = await app.isRateKeyLocked(testKey);
  assert.ok(isLocked > 0, 'Key should be locked immediately after failure');

  // Wait 1.1s for expiration
  await new Promise((r) => setTimeout(r, 1100));

  isLocked = await app.isRateKeyLocked(testKey);
  assert.strictEqual(isLocked, 0, 'Key should be unlocked after expiration time passes');
});

test('MULTI-INSTANCE SIMULATION: Two independent instances observe shared lockout state', async () => {
  app.resetRateLimitMemory();
  const sharedKey = 'multi_inst_user_' + Date.now();

  // Instance 1 records failures up to lockout
  await app.recordRateFailureOnKey(sharedKey, 2, 60, 300);
  await app.recordRateFailureOnKey(sharedKey, 2, 60, 300);

  // Instance 2 inspects lock state
  const inst2Locked = await app.isRateKeyLocked(sharedKey);
  assert.ok(inst2Locked > 0, 'Instance 2 must observe the lockout triggered by Instance 1');
});

test('CSRF COVERAGE: Comprehensive check across state-changing HTTP methods', async () => {
  // Obtain fresh CSRF tokens
  const initRes = await fetch(`${baseUrl}/api/csrf-token`);
  assert.strictEqual(initRes.status, 200);
  const setCookies = initRes.headers.get('set-cookie') || '';
  const secretMatch = setCookies.match(/_csrf_secret=([^;]+)/);
  const tokenMatch = setCookies.match(/XSRF-TOKEN=([^;]+)/);
  assert.ok(secretMatch, 'Must return _csrf_secret cookie');
  assert.ok(tokenMatch, 'Must return XSRF-TOKEN cookie');

  const secretCookie = `_csrf_secret=${secretMatch[1]}`;
  const validToken = tokenMatch[1];
  const dummySession = 'admin_session=mock_admin_session_val';

  // 1. POST with cookie session but missing CSRF token -> REJECT 403
  const postResMissingToken = await fetch(`${baseUrl}/api/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${secretCookie}; ${dummySession}`
    },
    body: JSON.stringify({ action: 'test' })
  });
  assert.strictEqual(postResMissingToken.status, 403, 'POST without CSRF token must be rejected 403');

  // 2. DELETE with cookie session but invalid CSRF token -> REJECT 403
  const delResInvalidToken = await fetch(`${baseUrl}/api/records/900191`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'invalid_token_123',
      cookie: `${secretCookie}; ${dummySession}`
    }
  });
  assert.strictEqual(delResInvalidToken.status, 403, 'DELETE with invalid CSRF token must be rejected 403');

  // 3. Untrusted origin on mutating POST -> REJECT 403
  const untrustedOriginRes = await fetch(`${baseUrl}/api/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': validToken,
      origin: 'https://attacker-phishing-site.com',
      cookie: `${secretCookie}; ${dummySession}`
    },
    body: JSON.stringify({ action: 'test' })
  });
  assert.strictEqual(untrustedOriginRes.status, 403, 'Untrusted origin must be rejected 403');

  // 4. Request with BOTH cookie session and custom header still requires valid CSRF
  const bypassAttemptRes = await fetch(`${baseUrl}/api/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'attacker_custom_token',
      cookie: `${secretCookie}; ${dummySession}` // ambient session cookie present!
    },
    body: JSON.stringify({ action: 'test' })
  });
  assert.strictEqual(bypassAttemptRes.status, 403, 'Custom header must not bypass CSRF when cookie session is present');
});
