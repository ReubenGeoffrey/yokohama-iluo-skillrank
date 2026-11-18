const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../server.js');
const { generateDepartmentSummaryHtml } = require('../report_html_generator.js');

describe('DEPARTMENT REPORT SUMMARY TESTS', () => {
  let server;
  let baseUrl;
  let adminCookie;
  let hodCookie;
  let operatorCookie;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Authenticate as Admin
    const adminRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.strictEqual(adminRes.status, 200);
    adminCookie = adminRes.headers.get('set-cookie');

    // 2. Authenticate as HOD
    const hodRes = await fetch(`${baseUrl}/api/auth/dept/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dept: 'Quality Control', password: 'hod123' })
    });
    assert.strictEqual(hodRes.status, 200);
    hodCookie = hodRes.headers.get('set-cookie');

    // 3. Authenticate as normal Operator / Employee
    const empRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: '900262' })
    });
    if (empRes.ok) {
      operatorCookie = empRes.headers.get('set-cookie');
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('REPORT 1: generateDepartmentSummaryHtml renders landscape ISO/IATF 16949 audit summary for Production', () => {
    const mockEmps = [
      { empNo: 'PR001', name: 'John Doe', dept: 'PRODUCTION', section: 'mixing', currentLevel: 'U' },
      { empNo: 'PR002', name: 'Jane Smith', dept: 'PRODUCTION', section: 'mixing', currentLevel: 'O' },
      { empNo: 'PR003', name: 'Bob Wilson', dept: 'PRODUCTION', section: '4 roll', currentLevel: 'I' }
    ];
    const mockSections = [
      { id: 'prod_mixing', name: 'MIXING', normName: 'mixing', code: 'PR-MIX', title: 'Mixing', dept: 'PRODUCTION' },
      { id: 'prod_4roll', name: '4 ROLL', normName: '4 roll', code: 'PR-4ROLL', title: '4 Roll Calender', dept: 'PRODUCTION' }
    ];
    const mockRecords = {
      'PR001': { isCompleted: true, totalMark: 28 },
      'PR002': { isCompleted: true, totalMark: 30 }
    };
    const mockOjt = {
      'PR001': { scorePct: 90, totalScore: 30 },
      'PR002': { scorePct: 95, totalScore: 30 }
    };

    const html = generateDepartmentSummaryHtml({
      dept: 'PRODUCTION',
      employees: mockEmps,
      records: mockRecords,
      ojtRecords: mockOjt,
      sections: mockSections,
      logoBase64: 'data:image/png;base64,mocklogo',
      shift: 'Shift 1 (06:00 - 14:00)'
    });

    assert.ok(html.includes('EXECUTIVE DEPARTMENT COMPETENCY SUMMARY REPORT — PRODUCTION DEPARTMENT'), 'Should contain report title');
    assert.ok(html.includes('IATF 16949 COMPLIANT'), 'Should cite IATF 16949 standard');
    assert.ok(html.includes('PR-MIX'), 'Should contain section code PR-MIX');
    assert.ok(html.includes('TOTAL (2 SECTIONS)'), 'Should contain grand total section count');
    assert.ok(html.includes('Skill Gap Analysis &amp; Training Action Plan'), 'Should include TNI skill gap section');
    assert.ok(html.includes('Head of Department (HOD) — Production Department'), 'Should include HOD sign-off block');
    assert.ok(html.includes('Plant Head / Quality Head'), 'Should include Plant Head approval block');
  });

  test('REPORT 2: GET /api/reports/department-summary/:dept enforces authorization', async () => {
    // Unauthenticated request should fail with 401
    const unauthRes = await fetch(`${baseUrl}/api/reports/department-summary/PRODUCTION`);
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated access must be rejected with 401');

    // Operator / regular employee request should fail with 403
    if (operatorCookie) {
      const forbiddenRes = await fetch(`${baseUrl}/api/reports/department-summary/PRODUCTION`, {
        headers: { Cookie: operatorCookie }
      });
      assert.strictEqual(forbiddenRes.status, 403, 'Normal operator access must be forbidden with 403');
    }

    // Admin request should succeed with 200 and return structured summary
    const adminReq = await fetch(`${baseUrl}/api/reports/department-summary/PRODUCTION`, {
      headers: { Cookie: adminCookie }
    });
    assert.strictEqual(adminReq.status, 200, 'Admin request should succeed with 200');
    const data = await adminReq.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.department, 'PRODUCTION');
    assert.ok(data.totalHeadcount >= 1000, 'Production headcount should be >= 1000 associates');
    assert.ok(data.sectionCount >= 20, 'Production sections should be >= 20');
    assert.ok(data.competencyMix !== undefined, 'Should provide competencyMix I, L, U, O');

    // HOD request should also succeed with 200
    const hodReq = await fetch(`${baseUrl}/api/reports/department-summary/QUALITY%20CONTROL`, {
      headers: { Cookie: hodCookie }
    });
    assert.strictEqual(hodReq.status, 200, 'HOD request should succeed with 200');
    const hodData = await hodReq.json();
    assert.strictEqual(hodData.success, true);
    assert.ok(hodData.totalHeadcount >= 250, 'QA headcount should be >= 250 associates');
  });

  test('REPORT 3: GET /api/reports/department-summary-html/:dept returns print-ready HTML for Admin', async () => {
    const res = await fetch(`${baseUrl}/api/reports/department-summary-html/PRODUCTION`, {
      headers: { Cookie: adminCookie }
    });
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('text/html'), 'Content-Type must be text/html');

    const html = await res.text();
    assert.ok(html.includes('EXECUTIVE DEPARTMENT COMPETENCY SUMMARY REPORT'), 'Must contain executive report heading');
    assert.ok(html.includes('YOKOHAMA GROUP'), 'Must contain Yokohama group branding');
    assert.ok(html.includes('TOTAL ('), 'Must contain summary table with grand totals');
    assert.ok(html.includes('Prepared &amp; Verified By'), 'Must contain sign-off block');
  });
});
