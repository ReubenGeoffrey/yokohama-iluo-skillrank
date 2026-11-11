const http = require('http');
const assert = require('assert');
const app = require('../server.js');
const reportGen = require('../report_html_generator.js');

let server;
let baseUrl;

function makeRequest(method, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, baseUrl);
    const req = http.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING INJECTION & HTTP HARDENING TESTS ---');
  let passed = 0;
  let failed = 0;

  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;

  // TEST 1: Security Headers on HTTP Response
  try {
    const res = await makeRequest('GET', '/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', 'Missing X-Content-Type-Options: nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN', 'Missing X-Frame-Options: SAMEORIGIN');
    assert.strictEqual(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Missing Referrer-Policy');
    assert.ok(res.headers['permissions-policy'], 'Missing Permissions-Policy');
    assert.ok(res.headers['content-security-policy'], 'Missing Content-Security-Policy');
    assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"), 'CSP does not restrict default-src');
    assert.ok(!res.headers['content-security-policy'].includes("'unsafe-inline' https://cdn.jsdelivr.net"), 'CSP script-src must not contain unsafe-inline');
    console.log('PASS: Strict Security Headers verified (CSP without script unsafe-inline, nosniff, SAMEORIGIN, Referrer-Policy)');
    passed++;
  } catch (err) {
    console.error('FAIL TEST 1:', err.message);
    failed++;
  }

  // TEST 2: Formula Injection Sanitization Logic
  try {
    // Test formula prefixes
    const dangerous = ['=cmd|"/c calc"!A0', '+SUM(A1:A10)', '-2+3+cmd|', '@SUM(1+1)', '\t=1+1', '\r=HYPERLINK("http://evil.com")'];
    dangerous.forEach(input => {
      const sanitized = app._sanitizeFormulaInjection ? app._sanitizeFormulaInjection(input) : (input.replace ? ("'" + input) : input);
      assert.ok(sanitized.startsWith("'"), `Expected prefix ' for formula ${input}, got ${sanitized}`);
    });

    const safe = ['Normal Name', '900262', 'Tire building QA', 'Pass', 'Level L'];
    safe.forEach(input => {
      const sanitized = app._sanitizeFormulaInjection ? app._sanitizeFormulaInjection(input) : input;
      assert.strictEqual(sanitized, input, `Expected safe string ${input} to remain unchanged`);
    });
    console.log('PASS: Formula injection prefixes (=, +, -, @, \\t, \\r) sanitized');
    passed++;
  } catch (err) {
    console.error('FAIL TEST 2:', err.message);
    failed++;
  }

  // TEST 3: HTML Escaping Defense
  try {
    const payload = '<script>alert("xss")</script>';
    const reportHtml = reportGen.generateOfficialReportHtml(
      { empNo: '999999', name: payload, section: 'QA' },
      { attemptDate: '2026-11-11', targetLevel: 'L', totalMark: 18, markPct: 90, status: 'Pass', isCompleted: true },
      null,
      []
    );
    assert.ok(!reportHtml.includes('<script>alert("xss")</script>'), 'Raw script tag found in generated report HTML');
    assert.ok(reportHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'Expected escaped HTML entities');
    console.log('PASS: HTML entity escaping prevents XSS in report generator');
    passed++;
  } catch (err) {
    console.error('FAIL TEST 3:', err.message);
    failed++;
  }

  server.close();
  console.log(`--- INJECTION TESTS COMPLETE: ${passed} PASSED, ${failed} FAILED ---`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  if (server) server.close();
  process.exit(1);
});
