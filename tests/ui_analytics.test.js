const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

process.env.NODE_ENV = 'test';
const app = require('../server.js');
const sharedConstants = require('../shared_constants.js');

const ROOT = path.resolve(__dirname, '..');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('UI & ASSETS 1: Original atg_logo.png is restored and modern minimalist SVGOwl icons are embedded cleanly', async () => {
  const logoRes = await fetch(`${baseUrl}/atg_logo.png`);
  assert.strictEqual(logoRes.status, 200);

  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const employeeHtml = fs.readFileSync(path.join(ROOT, 'employee.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  assert.ok(indexHtml.includes('href="atg_logo.png"') && !indexHtml.includes('iluo-brand.svg'));
  assert.ok(employeeHtml.includes('href="atg_logo.png"') && !employeeHtml.includes('iluo-brand.svg'));
  assert.ok(manifest.icons.every((i) => i.src === 'atg_logo.png'));
  assert.ok(!indexHtml.includes('.cls-1'), 'Inline SVGs must not collide on .cls-1 style blocks');
  assert.ok(!indexHtml.includes('id="🎨'), 'Inline SVGs must strip Sketch color path IDs');
  assert.ok(indexHtml.includes('SVGOwl Modern Minimalist Icons'), 'Sidebar and KPI cards must use SVGOwl minimalist icons');
  assert.ok(indexHtml.includes('styles.css?v=72.0'), 'Cache-busted stylesheet v72.0 must be referenced');
  assert.ok(!indexHtml.includes('viewBox="0 0 512 283.4"'), 'Old UXWing KPI group icon must be replaced');
  assert.ok(!indexHtml.includes('viewBox="0 0 122.88'), 'Legacy UXWing icons must be replaced with SVGOwl icons');
});

test('UI & ASSETS 2: Deprecated Dashboard header badges and Pillar Performance / Top Performers blocks are removed', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  assert.ok(!indexHtml.includes('id="adminDbStatusBadge"'), 'Dashboard Cloud DB badge must be removed');
  assert.ok(!indexHtml.includes('Exam Reset Management Center'), 'Old Exam Reset Management Center button/heading must be removed');
  assert.ok(!indexHtml.includes('Pillar Performance: Safety, Process, Quality, and CI &amp; TPM'), 'Pillar Performance block must be removed');
  assert.ok(!indexHtml.includes('Top Performers'), 'Top Performers pill must be removed');
  assert.ok(!indexHtml.includes('Top Safety'), 'Top Safety pill must be removed');
  assert.ok(!indexHtml.includes('Top Process'), 'Top Process pill must be removed');
  assert.ok(!indexHtml.includes('Top Quality'), 'Top Quality pill must be removed');
  assert.ok(!indexHtml.includes('Top CI &amp; TPM'), 'Top CI & TPM pill must be removed');
  assert.ok(!indexHtml.includes('Section Averages'), 'Old Section Averages pill must be removed');
  assert.ok(!indexHtml.includes('id="categoryPerformanceBarChart"'), 'Old categoryPerformanceBarChart canvas must be removed');
  assert.ok(!indexHtml.includes('id="categoryChampionsRow"'), 'Old champions row must be removed');
});

test('UI & ASSETS 3: Separate Exam Reset, Top-Level Database sidebar views, and 3-portal Bar-Line analytics exist', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Sidebar items & dedicated subviews
  assert.ok(indexHtml.includes('id="navCtrlReset"'));
  assert.ok(indexHtml.includes('id="navCtrlDatabase"'));
  assert.ok(indexHtml.includes('id="ctrlSubReset"'));
  assert.ok(indexHtml.includes('id="ctrlSubDatabase"'));

  // Cascading Department -> Section reset controls
  assert.ok(indexHtml.includes('id="adminResetDeptSelect"') && indexHtml.includes('onchange="onResetCascadeDeptChange()"'));
  assert.ok(indexHtml.includes('id="adminResetSecSelect"'));

  // All 3 portals (Admin, Dept HOD, Section Supervisor) have combo bar+line canvases & Completed/Not Finished controls
  assert.ok(indexHtml.includes('id="adminExecComboChart"'));
  assert.ok(indexHtml.includes('id="adminExecRosterBody"'));
  assert.ok(indexHtml.includes('id="deptExecComboChart"'));
  assert.ok(indexHtml.includes('id="deptExecRosterBody"'));
  assert.ok(indexHtml.includes('id="secExecComboChart"'));
  assert.ok(indexHtml.includes('id="secStatusTabCompleted"') && indexHtml.includes('id="secStatusTabPending"'));
});

test('ANALYTICS ENGINE 4: buildExecBuckets, summarizeExecPool, and cascading department sections compute accurate metrics', () => {
  const appCode = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const storage = new Map();
  const sandbox = {
    window: {},
    document: {
      cookie: '',
      documentElement: { getAttribute: () => 'light', setAttribute: () => {} },
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    ILUO_CONSTANTS: sharedConstants,
    EMPLOYEES: [
      { empNo: 'E1', name: 'Alice', dept: 'QUALITY CONTROL', section: 'Tire Building QA', currentLevel: 'L', targetLevel: 'U' },
      { empNo: 'E2', name: 'Bob', dept: 'QUALITY CONTROL', section: 'Tire Building QA', currentLevel: 'I', targetLevel: 'L' },
      { empNo: 'E3', name: 'Cara', dept: 'PRODUCTION', section: 'MIXING', currentLevel: 'U', targetLevel: 'O' },
      { empNo: 'E4', name: 'Dan', dept: 'PRODUCTION', section: 'MIXING', currentLevel: 'L', targetLevel: 'U' },
      { empNo: 'E5', name: 'LeftEmp', dept: 'PRODUCTION', section: 'MIXING', isLeft: true, status: 'LEFT' }
    ],
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  const records = {
    E1: { isCompleted: true, totalMark: 24, totalQuestions: 30, status: 'Passed' }, // 80% pass
    E2: { inProgress: true }, // in progress -> not finished
    E3: { isCompleted: true, totalMark: 16, totalQuestions: 40, status: 'Failed' }  // 40% fail
    // E4 not attempted -> not finished
  };
  storage.set('iluo_assessment_records_v3', JSON.stringify(records));

  const activeEmps = sandbox.EMPLOYEES.filter((e) => !e.isLeft);
  const summary = sandbox.summarizeExecPool(activeEmps, records);
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.completed, 2);
  assert.strictEqual(summary.inProgress, 1);
  assert.strictEqual(summary.notAttempted, 1);
  assert.strictEqual(summary.notFinished, 2);
  assert.strictEqual(summary.completionPct, 50);
  assert.strictEqual(summary.avgScorePct, 60); // (80 + 40) / 2
  assert.strictEqual(summary.passRatePct, 50); // 1 / 2 passed

  const secBuckets = sandbox.buildExecBuckets(activeEmps, records, 'section', 'alpha');
  assert.strictEqual(secBuckets.length, 2);
  const mixing = secBuckets.find((b) => b.key === 'MIXING');
  assert.strictEqual(mixing.completed, 1);
  assert.strictEqual(mixing.notFinished, 1);
  assert.strictEqual(mixing.avgScorePct, 40);

  const deptBuckets = sandbox.buildExecBuckets(activeEmps, records, 'department', 'pending-desc');
  assert.strictEqual(deptBuckets.length, 2);
  const qc = deptBuckets.find((b) => b.key === 'QUALITY CONTROL');
  assert.strictEqual(qc.completed, 1);
  assert.strictEqual(qc.inProgress, 1);
  assert.strictEqual(qc.avgScorePct, 80);

  const qcSections = sandbox.getSectionsForDepartmentClient('QUALITY CONTROL');
  assert.ok(qcSections.some((s) => s.value === 'tire_building' && s.completed === 1 && s.total === 2));
  const prodSections = sandbox.getSectionsForDepartmentClient('PRODUCTION');
  assert.ok(prodSections.some((s) => s.value === 'MIXING' && s.completed === 1 && s.total === 2));
});

test('STAFF RBAC 5: Aligned table columns and full Edit API (username, name, email, password, status, login)', async () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  // Verify exact column alignment order in table header and rendered row cells
  const tableMatch = indexHtml.match(/<table class="data-table responsive-cards rbac-users-table">[\s\S]*?<thead>([\s\S]*?)<\/thead>/);
  assert.ok(tableMatch, 'Staff RBAC users table must exist');
  const headers = Array.from(tableMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)).map((m) => m[1].trim());
  assert.deepStrictEqual(headers, ['Username', 'Name', 'Email', 'Role', 'Department / Section', 'Status', 'Actions']);

  // Ensure app.js cells match header order (Name before Email, plus Edit Action button)
  const rowRenderMatch = appCode.match(/function renderStaffUsersTable\(\)[\s\S]*?<td data-label="Username">[\s\S]*?<td data-label="Actions"/);
  assert.ok(rowRenderMatch, 'renderStaffUsersTable must render aligned columns with Edit button');
  const nameIdx = rowRenderMatch[0].indexOf('data-label="Name"');
  const emailIdx = rowRenderMatch[0].indexOf('data-label="Email"');
  assert.ok(nameIdx > 0 && emailIdx > nameIdx, 'Name cell must precede Email cell to match thead');

  // Ensure form arrangement fields & edit controls exist
  assert.ok(indexHtml.includes('id="staffUserEditId"'));
  assert.ok(indexHtml.includes('id="staffUserStatus"'));
  assert.ok(indexHtml.includes('id="btnCancelStaffEdit"'));
  assert.ok(indexHtml.includes('id="btnToggleStaffPw"'));
  assert.ok(indexHtml.includes('styles.css?v=72.0'));

  // Authenticate as Superadmin for API CRUD + Edit tests
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com',
      password: process.env.ADMIN_PASSWORD || 'admin123'
    })
  });
  assert.strictEqual(loginRes.status, 200);
  const { token } = await loginRes.json();

  // Create new DEPT_HEAD user via POST /api/admin/users
  const createRes = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({
      username: 'rbac.test.user',
      displayName: 'RBAC Original Name',
      email: 'rbac.orig@atctires.local',
      role: 'DEPT_HEAD',
      department: 'TECHNICAL',
      password: 'OldPass123!',
      isActive: true
    })
  });
  assert.strictEqual(createRes.status, 200);
  const createdData = await createRes.json();
  assert.strictEqual(createdData.success, true);
  assert.strictEqual(createdData.mode, 'created');
  const createdId = createdData.user.id;
  assert.ok(createdId > 0);
  assert.strictEqual(createdData.user.passwordHash, undefined, 'Response must never expose passwordHash');

  // Duplicate username create without id returns 409 Conflict
  const dupRes = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({
      username: 'rbac.test.user',
      displayName: 'Dup User',
      email: 'dup@atctires.local',
      role: 'ADMIN',
      password: 'Password123'
    })
  });
  assert.strictEqual(dupRes.status, 409);

  // Edit username, displayName, email, department, and password via PUT /api/admin/users/:id
  const editRes = await fetch(`${baseUrl}/api/admin/users/${createdId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({
      username: 'rbac.edited.user',
      displayName: 'RBAC Edited Display',
      email: 'rbac.edited@atctires.local',
      role: 'DEPT_HEAD',
      department: 'SAFETY',
      section: null,
      password: 'NewPass456!',
      isActive: true
    })
  });
  assert.strictEqual(editRes.status, 200);
  const editedData = await editRes.json();
  assert.strictEqual(editedData.success, true);
  assert.strictEqual(editedData.mode, 'updated');
  assert.strictEqual(editedData.user.username, 'rbac.edited.user');
  assert.strictEqual(editedData.user.displayName, 'RBAC Edited Display');
  assert.strictEqual(editedData.user.email, 'rbac.edited@atctires.local');
  assert.strictEqual(editedData.user.department, 'SAFETY');

  // Verify old password fails and new username + new password authenticates immediately
  const oldPwLogin = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'SAFETY', username: 'rbac.edited.user', password: 'OldPass123!' })
  });
  assert.strictEqual(oldPwLogin.status, 401);

  const newPwLogin = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'SAFETY', username: 'rbac.edited.user', password: 'NewPass456!' })
  });
  assert.strictEqual(newPwLogin.status, 200);
  const newLoginData = await newPwLogin.json();
  assert.strictEqual(newLoginData.user.name, 'RBAC Edited Display');

  // Verify password-blank edit preserves existing hashed password & status toggle to Disabled blocks login
  const disableRes = await fetch(`${baseUrl}/api/admin/users/${createdId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({
      username: 'rbac.edited.user',
      displayName: 'RBAC Edited Display',
      email: 'rbac.edited@atctires.local',
      role: 'DEPT_HEAD',
      department: 'SAFETY',
      isActive: false
    })
  });
  assert.strictEqual(disableRes.status, 200);
  const disabledLogin = await fetch(`${baseUrl}/api/auth/dept/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department: 'SAFETY', username: 'rbac.edited.user', password: 'NewPass456!' })
  });
  assert.strictEqual(disabledLogin.status, 401);
});
