const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const JSZip = require('jszip');

process.env.NODE_ENV = 'test';
const app = require('../server.js');
const excelSyncEngine = require('../excel_sync_engine.js');

let server;
let baseUrl;
let adminToken;
let preTestSnapshot = null;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Snapshot existing state so this test suite is 100% isolated & reversible
  const [employees, records, ojt] = await Promise.all([
    app.getAuthoritativeEmployees(),
    app.getAuthoritativeRecords(),
    app.getAuthoritativeOjtEvaluations()
  ]);
  preTestSnapshot = {
    employees: JSON.parse(JSON.stringify(employees)),
    records: JSON.parse(JSON.stringify(records)),
    ojt: JSON.parse(JSON.stringify(ojt))
  };

  // Obtain admin token
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.strictEqual(loginRes.status, 200);
  adminToken = (await loginRes.json()).token;
});

test.after(async () => {
  // Restore pre-test state cleanly
  if (preTestSnapshot) {
    await app.saveAuthoritativeEmployees(preTestSnapshot.employees);
    await app.saveAllAuthoritativeRecords(preTestSnapshot.records);
    await app.saveAllAuthoritativeOjtEvaluations(preTestSnapshot.ojt);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// 1. PURE UNIT TESTS: Formula / Threshold / NIL Parsing Rules
test('EXCEL SYNC 1: NIL handling, zero preservation, and Production/QA evaluation rules', () => {
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull('NIL'), null);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull(' nil '), null);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull(''), null);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull(null), null);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull(0), 0);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull('0'), 0);
  assert.strictEqual(excelSyncEngine.parseExcelNumberOrNull('14.5'), 14.5);

  // MaxMarks: I=20, L=20, U=30, O=40
  assert.strictEqual(excelSyncEngine.getKnowledgeMaxMarks('I'), 20);
  assert.strictEqual(excelSyncEngine.getKnowledgeMaxMarks('L'), 20);
  assert.strictEqual(excelSyncEngine.getKnowledgeMaxMarks('U'), 30);
  assert.strictEqual(excelSyncEngine.getKnowledgeMaxMarks('O'), 40);

  // Pass thresholds: L>=50%, U>=60%, O>=75%
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('L', 0.50), 'Pass');
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('L', 0.49), 'Fail');
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('U', 0.60), 'Pass');
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('U', 0.59), 'Fail');
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('O', 0.75), 'Pass');
  assert.strictEqual(excelSyncEngine.evaluateTemplatePassFail('O', 0.74), 'Fail');

  // Downgrade on Fail: O->U, U->L, L->I, I->I
  assert.strictEqual(excelSyncEngine.oneLevelDown('O'), 'U');
  assert.strictEqual(excelSyncEngine.oneLevelDown('U'), 'L');
  assert.strictEqual(excelSyncEngine.oneLevelDown('L'), 'I');
  assert.strictEqual(excelSyncEngine.oneLevelDown('I'), 'I');

  // Production overall evaluation: Pass only when both Quest & Gemba pass
  const passEval = excelSyncEngine.computeProductionEvaluation({
    eligibleLevel: 'O',
    safety: 6, process: 6, quality: 6, ciTpm: 6, system: 6, // 30/40 = 75%
    safety5s: 15, sopWiCheck: 12 // 27/35 = 77.1%
  });
  assert.strictEqual(passEval.knowledgeMark, 30);
  assert.strictEqual(passEval.knowledgeResult, 'Pass');
  assert.strictEqual(passEval.gembaMark, 27);
  assert.strictEqual(passEval.gembaResult, 'Pass');
  assert.strictEqual(passEval.overallResult, 'Pass');
  assert.strictEqual(passEval.afterEvaluationLevel, 'O');

  const failEval = excelSyncEngine.computeProductionEvaluation({
    eligibleLevel: 'O',
    safety: 5, process: 5, quality: 5, ciTpm: 5, system: 5, // 25/40 = 62.5% < 75%
    safety5s: 15, sopWiCheck: 15 // 30/35 = 85.7%
  });
  assert.strictEqual(failEval.knowledgeResult, 'Fail');
  assert.strictEqual(failEval.gembaResult, 'Pass');
  assert.strictEqual(failEval.overallResult, 'Fail');
  assert.strictEqual(failEval.afterEvaluationLevel, 'U');

  // QA experience skill: >48=O, >24=U, >3=L, else I
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2021-01-01', '2026-06-30').expSkillLevel, 'O'); // 65m > 48
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2022-06-30', '2026-06-30').expSkillLevel, 'U'); // 48m <= 48, > 24
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2024-05-01', '2026-06-30').expSkillLevel, 'U'); // 25m > 24
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2024-06-30', '2026-06-30').expSkillLevel, 'L'); // 24m <= 24, > 3
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2026-02-01', '2026-06-30').expSkillLevel, 'L'); // 4m > 3
  assert.strictEqual(excelSyncEngine.computeQaExperienceSkill('2026-03-30', '2026-06-30').expSkillLevel, 'I'); // 3m <= 3
});

// 2. RBAC PROTECTION ON SYNC & EXPORT ENDPOINTS
test('EXCEL SYNC 2: RBAC blocks unauthenticated (401) and Employee role (403)', async () => {
  // Unauthenticated checks -> 401
  const endpoints = [
    { method: 'GET', path: '/api/export/production-excel' },
    { method: 'GET', path: '/api/export/qa-excel' },
    { method: 'POST', path: '/api/excel-sync/preview', body: { useStoredTemplate: 'production' } },
    { method: 'POST', path: '/api/excel-sync/commit', body: { useStoredTemplate: 'production' } }
  ];

  for (const ep of endpoints) {
    const res = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: ep.body ? { 'Content-Type': 'application/json' } : {},
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.strictEqual(res.status, 401, `Unauthenticated ${ep.method} ${ep.path} must return 401`);
  }

  // Employee login token -> 403 on export & sync
  const empLogin = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: '900844', password: '900844' })
  });
  assert.strictEqual(empLogin.status, 200);
  const empToken = (await empLogin.json()).token;

  for (const ep of endpoints) {
    const res = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: {
        'x-employee-token': empToken,
        ...(ep.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.ok(
      res.status === 401 || res.status === 403,
      `Employee token on ${ep.method} ${ep.path} must be rejected (got ${res.status})`
    );
  }
});

// 3. PREVIEW ENDPOINT DOES NOT MUTATE DATABASE & REPORTS VALIDATION WARNINGS
test('EXCEL SYNC 3: Preview parses Production & QA templates accurately without mutating DB', async () => {
  const beforeEmps = await app.getAuthoritativeEmployees();
  const beforeCount = beforeEmps.length;

  // Upload Production template as base64
  const prodBuf = fs.readFileSync(excelSyncEngine.PRODUCTION_TEMPLATE_PATH);
  const prevProdRes = await fetch(`${baseUrl}/api/excel-sync/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({
      fileName: '1. PRODUCTION SKILL ASSESSMENT DATA 30.06.2026.xlsx',
      fileBase64: prodBuf.toString('base64'),
      fileType: 'auto'
    })
  });
  assert.strictEqual(prevProdRes.status, 200);
  const prevProdData = await prevProdRes.json();
  assert.strictEqual(prevProdData.success, true);
  assert.strictEqual(prevProdData.preview.fileType, 'production');
  assert.strictEqual(prevProdData.preview.totalParsedActive, 1460);
  assert.ok(prevProdData.preview.leftMarkedInactive >= 200, 'Should detect Left employees');
  assert.ok(prevProdData.preview.warnings.length > 0, 'Should surface duplicate EMP NO warnings');

  // Preview QA template via base64
  const qaBuf = fs.readFileSync(excelSyncEngine.QA_TEMPLATE_PATH);
  const prevQaRes = await fetch(`${baseUrl}/api/excel-sync/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({
      fileName: 'QA_Workman name list_24.09.2026.xlsx',
      fileBase64: qaBuf.toString('base64'),
      fileType: 'auto'
    })
  });
  assert.strictEqual(prevQaRes.status, 200);
  const prevQaData = await prevQaRes.json();
  assert.strictEqual(prevQaData.success, true);
  assert.strictEqual(prevQaData.preview.fileType, 'qa');
  assert.strictEqual(prevQaData.preview.totalParsedActive, 283);

  // Confirm DB was NOT mutated by preview calls
  const afterEmps = await app.getAuthoritativeEmployees();
  assert.strictEqual(afterEmps.length, beforeCount, 'Preview must not mutate database');
});

// 4. COMMIT UPSERT (PRODUCTION + QA), NO DUPLICATES, LEFT EMPLOYEE EXCLUSION & LOGIN BLOCK
test('EXCEL SYNC 4: Commit upserts Production & QA cleanly, marks Left inactive, blocks Left login, preserves 2026 level', async () => {
  // Commit Production template
  const commitProdRes = await fetch(`${baseUrl}/api/excel-sync/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({ useStoredTemplate: 'production' })
  });
  assert.strictEqual(commitProdRes.status, 200);
  const commitProd = await commitProdRes.json();
  assert.strictEqual(commitProd.success, true);
  assert.ok(commitProd.backupId, 'Commit must create a 30-min undo backup snapshot');

  // Commit QA template right after Production
  const commitQaRes = await fetch(`${baseUrl}/api/excel-sync/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({ useStoredTemplate: 'qa' })
  });
  assert.strictEqual(commitQaRes.status, 200);
  const commitQa = await commitQaRes.json();
  assert.strictEqual(commitQa.success, true);

  // Verify zero duplicate EMP NOs across the entire store
  const allEmps = await app.getAuthoritativeEmployees();
  const seen = new Set();
  for (const e of allEmps) {
    const key = excelSyncEngine.normalizeEmpNo(e.empNo);
    assert.ok(!seen.has(key), `Duplicate EMP NO detected after upsert: ${key}`);
    seen.add(key);
  }

  // Verify 900844 retained 2026 evaluated level 'O' after QA 2025 sync
  const emp900844 = allEmps.find(e => excelSyncEngine.normalizeEmpNo(e.empNo) === '900844');
  assert.ok(emp900844, '900844 must exist');
  assert.strictEqual(emp900844.afterEvaluationLevel, 'O');
  assert.strictEqual(emp900844.currentLevel, 'O', 'QA 2025 sync must not downgrade 2026 evaluated currentLevel');
  assert.strictEqual(emp900844.skillLevelAssess2025, 'U', 'QA 2025 assessment level must still be preserved');

  // Verify default GET /api/employees excludes Left employees, while ?includeLeft=true includes them
  const activeRes = await fetch(`${baseUrl}/api/employees`, {
    headers: { 'x-admin-token': adminToken }
  });
  const activeData = await activeRes.json();
  assert.ok(activeData.leftCount >= 200, 'Response must report leftCount');
  assert.strictEqual(
    activeData.employees.some(e => e.isLeft || e.status === 'LEFT'),
    false,
    'Default GET /api/employees must exclude Left employees'
  );

  const inclRes = await fetch(`${baseUrl}/api/employees?includeLeft=true`, {
    headers: { 'x-admin-token': adminToken }
  });
  const inclData = await inclRes.json();
  const leftEmp = inclData.employees.find(e => e.isLeft || e.status === 'LEFT');
  assert.ok(leftEmp, 'includeLeft=true must return Left employees');

  // Verify Left employee cannot log in (403)
  const leftLoginRes = await fetch(`${baseUrl}/api/auth/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: leftEmp.empNo, password: leftEmp.empNo })
  });
  assert.strictEqual(leftLoginRes.status, 403, 'Left/Inactive employee login must be blocked with 403');
});

// 5. EXACT TEMPLATE-CLONING PRODUCTION EXCEL EXPORT VERIFICATION
test('EXCEL SYNC 5: GET /api/export/production-excel preserves all 6 sheets, native chart, fullCalcOnLoad, and live formulas', async () => {
  const res = await fetch(`${baseUrl}/api/export/production-excel`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.match(res.headers.get('content-disposition') || '', /1\. PRODUCTION SKILL ASSESSMENT DATA \d{4}-\d{2}-\d{2}\.xlsx/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf[0], 0x50); // 'P'
  assert.strictEqual(buf[1], 0x4b); // 'K'

  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  assert.ok(wbXml.includes('fullCalcOnLoad="1"'), 'Exported Production workbook must set fullCalcOnLoad="1"');
  assert.ok(zip.file('xl/charts/chart1.xml'), 'Native Excel chart (xl/charts/chart1.xml) must be preserved');
  assert.ok(zip.file('xl/drawings/drawing1.xml'), 'Native Excel drawing (xl/drawings/drawing1.xml) must be preserved');

  const { workbook } = await excelSyncEngine.loadExcelJsWorkbookSafely(buf);
  const sheetNames = workbook.worksheets.map(ws => ws.name);
  assert.deepStrictEqual(sheetNames, [
    'Plant Head 17.08',
    '2025-2026 comp',
    'Abstract',
    'Name list',
    'Left',
    'Entry sheet'
  ]);

  // Verify summary sheet COUNTIFS formula untouched
  const abstractSheet = workbook.getWorksheet('Abstract');
  assert.ok(
    String(abstractSheet.getCell('D4').value?.formula || '').includes('COUNTIFS'),
    'Abstract summary sheet COUNTIFS formula must remain intact'
  );

  // Verify live Excel formulas on Name list row 3
  const nameSheet = workbook.getWorksheet('Name list');
  assert.strictEqual(nameSheet.getCell('A3').value?.formula, 'ROW()-2');
  assert.strictEqual(nameSheet.getCell('A4').value?.formula, 'ROW()-2');
  assert.ok(String(nameSheet.getCell('G3').value?.formula || '').includes('NOW()-F3'), 'Row 3 Exp formula must reference NOW()-F3');
  assert.strictEqual(nameSheet.getCell('O3').value?.formula, 'SUM(J3:N3)');
  assert.ok(String(nameSheet.getCell('P3').value?.formula || '').includes('O3/'), 'Knowledge % formula must reference O3');
  assert.ok(String(nameSheet.getCell('Q3').value?.formula || '').includes('P3'), 'Quest Result formula must reference P3');
  assert.strictEqual(nameSheet.getCell('U3').value?.formula, 'SUM(S3:T3)');
  assert.strictEqual(
    nameSheet.getCell('V3').value?.formula,
    'U3/IF(H3="L",35,IF(H3="U",35,IF(H3="O",35,IF(H3="I",35,""))))'
  );
  assert.ok(String(nameSheet.getCell('W3').value?.formula || '').includes('V3'), 'Gemba Result formula must reference V3');
  assert.strictEqual(nameSheet.getCell('X3').value?.formula, 'IF(AND(Q3="Pass", W3="Pass"), "Pass", "Fail")');
  assert.ok(String(nameSheet.getCell('Y3').value?.formula || '').includes('X3="Pass"'), 'After evaluation skill level formula must reference X3');
});

// 6. EXACT TEMPLATE-CLONING QA EXCEL EXPORT VERIFICATION
test('EXCEL SYNC 6: GET /api/export/qa-excel preserves all 5 sheets, hidden states, fullCalcOnLoad, and live formulas', async () => {
  const res = await fetch(`${baseUrl}/api/export/qa-excel`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.match(res.headers.get('content-disposition') || '', /QA_Workman_name_list_\d{4}-\d{2}-\d{2}\.xlsx/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf[0], 0x50);
  assert.strictEqual(buf[1], 0x4b);

  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  assert.ok(wbXml.includes('fullCalcOnLoad="1"'), 'Exported QA workbook must set fullCalcOnLoad="1"');

  const { workbook } = await excelSyncEngine.loadExcelJsWorkbookSafely(buf);
  const sheetsAndStates = workbook.worksheets.map(ws => `${ws.name}:${ws.state}`);
  assert.deepStrictEqual(sheetsAndStates, [
    'ILUO Abstract (2):hidden',
    'Dept wise:hidden',
    'Exp wise summary:hidden',
    'Sec wise Summary:visible',
    'Name list:visible'
  ]);

  // Verify Sec wise Summary COUNTIFS formula untouched
  const secSheet = workbook.getWorksheet('Sec wise Summary');
  assert.ok(
    String(secSheet.getCell('B4').value?.formula || '').includes('COUNTIFS'),
    'Sec wise Summary COUNTIFS formula must remain intact'
  );

  // Verify live Excel formulas on QA Name list rows 2 & 3
  const nameSheet = workbook.getWorksheet('Name list');
  assert.strictEqual(nameSheet.getCell('A2').value, 1);
  assert.strictEqual(nameSheet.getCell('A3').value?.formula, 'A2+1');
  assert.ok(String(nameSheet.getCell('I3').value?.formula || '').includes('DATEDIF(G3, H3, "M")'));
  assert.ok(String(nameSheet.getCell('J3').value?.formula || '').includes('I3'));
  assert.ok(String(nameSheet.getCell('K3').value?.formula || '').includes('DATEDIF(G3,H3,"M")>48'));
});

// 7. PRODUCTION & QA SECTION-WISE COMPLETION SUMMARY AGGREGATOR VERIFICATION
test('EXCEL SYNC 7: buildSectionSummaryReportData aggregates 25 Production sections & excludes Left employees', () => {
  const sampleEmps = [
    { empNo: 'P101', name: 'Prod One', dept: 'PRODUCTION', section: 'MIXING', currentLevel: 'U', isLeft: false, status: 'ACTIVE' },
    { empNo: 'P102', name: 'Prod Two', dept: 'PRODUCTION', section: 'TYRE CURING', currentLevel: 'L', isLeft: false, status: 'ACTIVE' },
    { empNo: 'P103', name: 'Prod Left', dept: 'PRODUCTION', section: 'MIXING', currentLevel: 'O', isLeft: true, status: 'LEFT' },
    { empNo: 'Q201', name: 'QA One', dept: 'QUALITY CONTROL', section: 'Tire Building QA', currentLevel: 'O', isLeft: false, status: 'ACTIVE' }
  ];
  const sampleRecs = {
    P101: { isCompleted: true, status: 'Passed', markPct: 80 },
    P102: { isCompleted: false, inProgress: true }
  };
  const sampleOjt = {
    P101: { totalScore: 30, scorePct: 86, result: 'Pass' },
    P102: { totalScore: 26, scorePct: 74, result: 'Pass' }
  };

  const prodSummary = app.buildSectionSummaryReportData(sampleEmps, sampleRecs, sampleOjt, 'PRODUCTION');
  assert.strictEqual(prodSummary.scope, 'PRODUCTION');
  assert.strictEqual(prodSummary.sections.length, 25);
  assert.strictEqual(prodSummary.totals.total, 2);
  assert.strictEqual(prodSummary.totals.examDone, 1);
  assert.strictEqual(prodSummary.totals.ojtDone, 2);
  assert.strictEqual(prodSummary.totals.bothDone, 1);
  assert.strictEqual(prodSummary.totals.pending, 1);
  assert.strictEqual(prodSummary.totals.completionPct, 50);
  assert.strictEqual(prodSummary.leftCount, 1);

  const mixingRow = prodSummary.sections.find(s => s.name === 'MIXING');
  assert.ok(mixingRow);
  assert.strictEqual(mixingRow.total, 1);
  assert.strictEqual(mixingRow.bothDone, 1);
  assert.strictEqual(mixingRow.completionPct, 100);

  const qaSummary = app.buildSectionSummaryReportData(sampleEmps, sampleRecs, sampleOjt, 'QA');
  assert.strictEqual(qaSummary.scope, 'QA');
  assert.strictEqual(qaSummary.sections.length, 8);
  assert.strictEqual(qaSummary.totals.total, 1);
});

// 8. SECTION COMPLETION SUMMARY PDF EXPORT ENDPOINT VERIFICATION
test('EXCEL SYNC 8: GET /api/export/section-summary-pdf enforces auth and returns valid binary PDF for Production', async () => {
  const unauthRes = await fetch(`${baseUrl}/api/export/section-summary-pdf?scope=PRODUCTION`);
  assert.strictEqual(unauthRes.status, 401);

  const pdfRes = await fetch(`${baseUrl}/api/export/section-summary-pdf?scope=PRODUCTION`, {
    headers: { 'x-admin-token': adminToken }
  });
  assert.strictEqual(pdfRes.status, 200);
  assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition') || '', /Yokohama_Production_Section_Summary_\d{4}-\d{2}-\d{2}\.pdf/);

  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(pdfBuf.length > 5000, 'Generated Production Summary PDF should not be empty');
  assert.strictEqual(pdfBuf.subarray(0, 5).toString('utf8'), '%PDF-');
});
