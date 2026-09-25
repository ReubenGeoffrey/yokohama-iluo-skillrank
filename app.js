// Yokohama ILUO MCQ Assessment Application Logic & Router

// LocalStorage Keys
const STORAGE_KEY_RECORDS = 'iluo_assessment_records_v2';
const STORAGE_KEY_SESSION = 'iluo_current_session_v1';
const STORAGE_KEY_OJT = 'yokohama_ojt_evaluations_v1';
const STORAGE_KEY_CUSTOM_EMPLOYEES = 'yokohama_custom_employees_v1';
const STORAGE_KEY_CUSTOM_QUESTIONS = 'yokohama_custom_questions_v1';

// Global App State
let currentUser = null; // { empNo, name, dept, section, doj, currentLevel, targetLevel }
let activeExam = null; // { empNo, targetLevel, questions, currentIndex, responses, remainingSeconds, tabSwitchCount, isCompleted }
let timerInterval = null;
let pieChartInstance = null;
let barChartInstance = null;
let lastTabSwitchTime = 0; // Debounce duplicate events
let currentActiveSection = 'Tire building QA';
let currentActiveSectionKey = 'warehouse';
let currentActiveSectionTab = 'employees';

const QA_SECTIONS_LIST = [
  { id: 'warehouse', name: 'Ware House QA', normName: 'warehouse qa', code: 'WH', title: 'Warehouse QA' },
  { id: 'final_finish', name: 'Final Finish QA', normName: 'final finish qa', code: 'FF', title: 'Final Finish QA' },
  { id: 'tire_building', name: 'Tire building QA', normName: 'tire building qa', code: 'TB', title: 'Tire Building QA' },
  { id: 'tire_curing', name: 'Tire curing QA', normName: 'tire curing qa', code: 'TC', title: 'Tire Curing QA' },
  { id: 'solid_tire', name: 'Solid Tire QA', normName: 'solid tire qa', code: 'ST', title: 'Solid Tire QA' },
  { id: 'rro_alt', name: 'Final Finish RRO & ALT QA', normName: 'final finish rro & alt qa', code: 'RA', title: 'Final Finish RRO & ALT QA' },
  { id: 'preparatory', name: 'Preparatory QA', normName: 'preparatory qa', code: 'PR', title: 'Preparatory QA' },
  { id: 'fid_inspector', name: 'FID Inspector QA', normName: 'fid inspector qa', code: 'FD', title: 'FID Inspector QA' }
];

// Initialize App & Router
document.addEventListener('DOMContentLoaded', () => {
  initStorage();
  initSecurityMonitors();
  window.addEventListener('hashchange', handleRoute);
  checkExistingSession();
});

// Reliable network request helper with strict timeout to prevent browser tab loading hangs
async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function initStorage() {
  // Purge legacy pre-populated records from previous versions to guarantee clean 0 finished exams
  try {
    localStorage.removeItem('iluo_assessment_records_v1');
  } catch (e) {}

  if (!localStorage.getItem(STORAGE_KEY_RECORDS)) {
    localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify({}));
  }
  // Immediate localStorage bootstrap for questions & employees
  try {
    const cachedQ = localStorage.getItem(STORAGE_KEY_CUSTOM_QUESTIONS);
    if (cachedQ) {
      const parsedQ = JSON.parse(cachedQ);
      ['L', 'U', 'O'].forEach(lvl => {
        if (parsedQ[lvl] && Array.isArray(parsedQ[lvl])) {
          QUESTION_BANK[lvl] = parsedQ[lvl];
        }
      });
    }
  } catch (e) {}

  try {
    const cachedEmp = localStorage.getItem(STORAGE_KEY_CUSTOM_EMPLOYEES);
    if (cachedEmp) {
      const parsedEmp = JSON.parse(cachedEmp);
      if (Array.isArray(parsedEmp) && parsedEmp.length > 0) {
        EMPLOYEES.length = 0;
        EMPLOYEES.push(...parsedEmp);
      }
    }
  } catch (e) {}

  // Stagger cloud syncs non-blockingly so initial render and tab spinner clear in 0ms
  setTimeout(() => {
    syncCloudRecords();
    syncCloudOjtEvaluations();
  }, 1200);

  setTimeout(() => {
    syncCloudQuestions();
    syncCloudEmployees();
    syncCloudSettings();
  }, 3000);
}

function getAuthHeaders(extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  try {
    const sessStr = localStorage.getItem(STORAGE_KEY_SESSION);
    if (sessStr) {
      const sess = JSON.parse(sessStr);
      if (sess.token) {
        headers['x-emp-token'] = sess.token;
        headers['x-admin-token'] = sess.token;
      }
    }
    const empTok = localStorage.getItem('yokohama_emp_token');
    if (empTok) headers['x-emp-token'] = empTok;
  } catch (e) {}
  return headers;
}

function getStoredRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RECORDS);
    if (!raw) {
      const initial = (typeof YOKOHAMA_SEED_RECORDS !== 'undefined' && YOKOHAMA_SEED_RECORDS && Object.keys(YOKOHAMA_SEED_RECORDS).length > 0)
        ? { ...YOKOHAMA_SEED_RECORDS }
        : {};
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function saveRecord(empNo, recordData) {
  const records = getStoredRecords();
  records[empNo] = { ...records[empNo], ...recordData };
  localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));

  // Sync to server cloud API in background
  try {
    fetchWithTimeout('/api/records', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ empNo, recordData })
    }, 5000).catch(err => console.log('Server sync pending:', err.message));
  } catch (e) {}
}

async function syncCloudRecords() {
  try {
    const res = await fetchWithTimeout('/api/records', { headers: getAuthHeaders() }, 3500);
    const data = await res.json();
    if (data.success && data.records !== undefined) {
      const serverRecords = data.records || {};
      const serverCount = Object.keys(serverRecords).length;
      const local = getStoredRecords();
      const localCount = Object.keys(local).length;

      let merged;
      // If server explicitly holds 0 finished exams and local wasn't explicitly flagged to preserve
      if (serverCount === 0 && localCount > 0 && !localStorage.getItem('iluo_preserve_local')) {
        merged = {};
      } else {
        // Authoritative server records overwrite local stale records
        merged = { ...local, ...serverRecords };
      }
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(merged));
      // Re-render admin table and dashboard if active
      if (document.getElementById('adminTableBody')) {
        const searchInput = document.getElementById('adminSearchInput');
        renderAdminTable(searchInput ? searchInput.value : '');
      }
      if (typeof renderAdminDashboard === 'function') {
        renderAdminDashboard();
      }
    }
  } catch (e) {}
}

async function syncCloudOjtEvaluations() {
  try {
    const res = await fetchWithTimeout('/api/ojt-evaluations', {}, 3500);
    const data = await res.json();
    if (data.success && data.evaluations) {
      const local = getStoredOjtRecords();
      const merged = { ...local, ...data.evaluations };
      localStorage.setItem(STORAGE_KEY_OJT, JSON.stringify(merged));
      // Re-render admin table if visible
      if (document.getElementById('adminTableBody')) {
        const searchInput = document.getElementById('adminSearchInput');
        renderAdminTable(searchInput ? searchInput.value : '');
      }
    }
  } catch (e) {}
}

async function syncCloudQuestions() {
  try {
    const res = await fetchWithTimeout('/api/questions', {}, 4000);
    const data = await res.json();
    if (data.success && data.questionBank) {
      ['L', 'U', 'O'].forEach(lvl => {
        if (data.questionBank[lvl] && Array.isArray(data.questionBank[lvl])) {
          QUESTION_BANK[lvl] = data.questionBank[lvl];
        }
      });
      try {
        localStorage.setItem(STORAGE_KEY_CUSTOM_QUESTIONS, JSON.stringify(QUESTION_BANK));
      } catch (e) {}
      if (document.getElementById('questionsListContainer')) {
        renderQuestionsManager();
      }
    }
  } catch (e) {}
}

function saveCustomQuestionsToServer() {
  try {
    localStorage.setItem(STORAGE_KEY_CUSTOM_QUESTIONS, JSON.stringify(QUESTION_BANK));
  } catch (e) {}
  try {
    fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionBank: QUESTION_BANK })
    }).then(res => res.json()).then(data => {
      console.log('Question Bank Cloud Save Status:', data.message);
    }).catch(err => console.log('Question cloud sync pending:', err.message));
  } catch (e) {}
}

// // ---------------------------------------------------------------------
// URL ROUTER ENGINE (4-Role Portals: Employee, Section, HOD, HR Admin)
// ---------------------------------------------------------------------
function navigateTo(path) {
  const targetHash = path.startsWith('/') ? path : '/' + path;
  if (window.location.hash === '#' + targetHash) {
    handleRoute();
  } else {
    window.location.hash = targetHash;
  }
}

function updateRoleNavHighlight(role) {
  ['tabRoleHome', 'tabRoleEmp', 'tabRoleSection', 'tabRoleDept', 'tabRoleAdmin', 'tabRoleOjt'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active');
  });

  const map = {
    'home': 'tabRoleHome',
    'employee': 'tabRoleEmp',
    'section': 'tabRoleSection',
    'department': 'tabRoleDept',
    'hod': 'tabRoleDept',
    'admin': 'tabRoleAdmin',
    'ojt': 'tabRoleOjt',
    'ojt-login': 'tabRoleOjt'
  };
  const targetId = map[role];
  if (targetId) {
    const btn = document.getElementById(targetId);
    if (btn) btn.classList.add('active');
  }
}

function handleRoute() {
  const rawHash = window.location.hash.slice(1);
  const hash = rawHash || '/';
  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  const session = sessionStr ? JSON.parse(sessionStr) : null;

  // Root Public Hub Landing Page (/)
  if (hash === '/' || hash === '' || hash === '/public') {
    showView('viewPublicLanding');
    updateRoleNavHighlight('home');
    updateUserBadge(session && session.name ? session.name : (session && session.role === 'admin' ? 'Administrator' : null));
    return;
  }

  // Dedicated OJT Portal Route (/ojt, /ojt-login)
  if (hash === '/ojt' || hash === '/ojt-login' || hash.startsWith('/ojt/')) {
    updateRoleNavHighlight('ojt');
    showView('viewOjtPortal');
    const ojtSession = sessionStorage.getItem('iluo_ojt_session');
    const loginWrapper = document.getElementById('ojtLoginWrapper');
    const dashWrapper = document.getElementById('ojtDashboardWrapper');
    if (ojtSession) {
      if (loginWrapper) loginWrapper.style.display = 'none';
      if (dashWrapper) dashWrapper.style.display = 'block';
      renderOjtDashboard(ojtSession);
    } else {
      if (loginWrapper) loginWrapper.style.display = 'block';
      if (dashWrapper) dashWrapper.style.display = 'none';
    }
    return;
  }

  // Quick Direct OJT Modal Route (/ojt-modal, /ojt-evaluation, /ojt-form)
  if (hash === '/ojt-modal' || hash === '/ojt-evaluation' || hash === '/ojt-form') {
    if (typeof hasOjtEvaluationAccess === 'function' && !hasOjtEvaluationAccess()) {
      showToast('Access Restricted: OJT practical evaluations are only accessible to Section Supervisors and Admins.');
      navigateTo('/section');
      return;
    }
    showView('viewPublicLanding');
    openOjtModalQuick();
    return;
  }

  // ILUO Standards & SOP Modal Route
  if (hash === '/iluo-standards' || hash === '/sop') {
    showView('viewPublicLanding');
    openSopModal();
    return;
  }

  // Section Portal (/section)
  if (hash === '/section' || hash.startsWith('/section/')) {
    updateRoleNavHighlight('section');
    showView('viewSectionPortal');
    const secSession = sessionStorage.getItem('iluo_section_session') || currentActiveSection;
    const loginWrapper = document.getElementById('sectionLoginWrapper');
    const dashWrapper = document.getElementById('sectionDashboardWrapper');
    if (sessionStorage.getItem('iluo_section_session')) {
      if (loginWrapper) loginWrapper.style.display = 'none';
      if (dashWrapper) dashWrapper.style.display = 'block';
      renderSectionDashboard(secSession);
    } else {
      if (loginWrapper) loginWrapper.style.display = 'block';
      if (dashWrapper) dashWrapper.style.display = 'none';
    }
    return;
  }

  // Department / HOD Portal (/department or /hod)
  if (hash === '/department' || hash === '/hod' || hash.startsWith('/department/')) {
    updateRoleNavHighlight('department');
    showView('viewDepartmentPortal');
    const loginWrapper = document.getElementById('deptLoginWrapper');
    const dashWrapper = document.getElementById('deptDashboardWrapper');
    if (sessionStorage.getItem('iluo_dept_session')) {
      if (loginWrapper) loginWrapper.style.display = 'none';
      if (dashWrapper) dashWrapper.style.display = 'block';
      renderDepartmentDashboard();
    } else {
      if (loginWrapper) loginWrapper.style.display = 'block';
      if (dashWrapper) dashWrapper.style.display = 'none';
    }
    return;
  }

  // Explicit Employee Login Page (/employee-portal)
  if (hash === '/employee-portal' || hash === '/employee/login') {
    updateRoleNavHighlight('employee');
    showView('viewEmpLogin');
    return;
  }

  // Explicit Admin Login Page (/secure-control)
  if (hash === '/secure-control' || hash === '/admin-login' || hash === '/admin') {
    updateRoleNavHighlight('admin');
    if (session && session.role === 'admin') {
      navigateTo('/secure-control/dashboard');
      return;
    }
    showView('viewAdminLogin');
    return;
  }

  // Protect Admin routes (/control-center/* and /secure-control/* subviews)
  if (hash.startsWith('/control-center') || hash.startsWith('/secure-control/')) {
    updateRoleNavHighlight('admin');
    if (!session || session.role !== 'admin') {
      navigateTo('/secure-control');
      return;
    }
    updateUserBadge(session.name || 'Administrator');
    
    let sub = hash.replace(/^\/(control-center|secure-control)\/?/, '').trim();
    if (!sub) sub = 'dashboard';
    showControlCenterSubView(sub);
    return;
  }

  // Protect Employee routes (/employee/*)
  if (hash.startsWith('/employee/')) {
    updateRoleNavHighlight('employee');
    if (!currentUser) {
      navigateTo('/employee-portal');
      return;
    }
    
    if (currentUser) updateUserBadge(currentUser.name);

    if (hash === '/employee/dashboard') {
      showEmpDashboard();
    } else if (hash === '/employee/exams') {
      showEmpExamsView();
    } else if (hash.startsWith('/employee/exam/')) {
      showView('viewQuiz');
    } else if (hash === '/employee/results') {
      showEmpResultsView();
    } else if (hash === '/employee/profile') {
      showEmpProfileView();
    }
    return;
  }

  showView('viewPublicLanding');
}

// ---------------------------------------------------------------------
// SECURITY MONITORS: Copy-Paste Restriction & Non-Intrusive Monitoring
// ---------------------------------------------------------------------
function initSecurityMonitors() {
  // Prevent Copy, Cut, Paste, Right Click during exam
  ['copy', 'cut', 'paste', 'contextmenu'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      if (isExamActive()) {
        e.preventDefault();
        showToast('Action restricted during assessment!');
      }
    });
  });

  // Prevent keyboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, F12, DevTools)
  document.addEventListener('keydown', (e) => {
    if (isExamActive()) {
      const forbiddenKeys = ['F12', 'u', 'i', 'j', 'c', 'v', 'x', 'a', 's', 'p'];
      if (
        e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && forbiddenKeys.includes(e.key.toLowerCase())) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c', 'k'].includes(e.key.toLowerCase()))
      ) {
        e.preventDefault();
        showToast('Keyboard shortcut blocked during assessment!');
      }
    }
  });

  // Focus Loss Monitor (Non-intrusive logging)
  const handleTabSwitch = () => {
    if (!isExamActive()) return;

    const now = Date.now();
    if (now - lastTabSwitchTime < 1500) return;
    lastTabSwitchTime = now;

    if (!activeExam.tabSwitchCount) activeExam.tabSwitchCount = 0;
    activeExam.tabSwitchCount++;

    saveRecord(activeExam.empNo, {
      tabSwitchCount: activeExam.tabSwitchCount
    });

    updateTabWarningBadge();
    showToast(`Notice: Assessment window lost focus (${activeExam.tabSwitchCount})`);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) handleTabSwitch();
  });

  window.addEventListener('blur', () => {
    handleTabSwitch();
  });
}

function isExamActive() {
  return activeExam && !activeExam.isCompleted && document.getElementById('viewQuiz').classList.contains('active');
}

function updateTabWarningBadge() {
  const badgeContainer = document.getElementById('tabWarningBadgeContainer');
  const countDisplay = document.getElementById('tabSwitchCountDisplay');
  
  const count = activeExam ? (activeExam.tabSwitchCount || 0) : 0;
  if (countDisplay) countDisplay.innerText = `${count}`;

  if (badgeContainer) {
    if (count > 0) badgeContainer.classList.add('danger');
    else badgeContainer.classList.remove('danger');
  }
}

function showSecurityWarningModal(count) {}
function closeSecurityWarningModal() {}

function terminateExamOnViolation(reason) {
  if (timerInterval) clearInterval(timerInterval);
  if (!activeExam) return;

  activeExam.isCompleted = true;
  closeSecurityWarningModal();
  showToast(`Exam auto-submitted due to: ${reason}`);
  submitAssessment();
}

// ---------------------------------------------------------------------
// Session & Navigation Check (Instant & Non-Blocking)
// ---------------------------------------------------------------------
function checkExistingSession() {
  // 1. Instant local check (zero network delay)
  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  if (sessionStr) {
    try {
      const session = JSON.parse(sessionStr);
      if (session.role === 'admin') {
        updateUserBadge(session.name || 'Administrator');
      } else if (session.empNo) {
        const emp = EMPLOYEES.find(e => e.empNo === session.empNo);
        if (emp) {
          currentUser = emp;
          updateUserBadge(emp.name);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 2. Render route immediately without waiting for network response
  if (!window.location.hash) {
    navigateTo('/');
  } else {
    handleRoute();
  }

  // 3. Background asynchronous verification (non-blocking, 3s timeout)
  fetchWithTimeout('/api/auth/admin/session', {}, 3000)
    .then(res => res.json())
    .then(data => {
      if (data.authenticated && data.admin) {
        localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({ role: 'admin', email: data.admin.email, name: data.admin.name }));
        updateUserBadge(data.admin.name);
      }
    })
    .catch(() => {});
}

// Toast Notifications
function showToast(msg) {
  const toast = document.getElementById('toast');
 toast.innerText = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Show View Helper
function showView(viewId) {
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  const roleNav = document.getElementById('roleNavBar');
  if (roleNav) {
    roleNav.style.display = 'flex';
    const tabMap = {
      'viewPublicLanding': 'tabRoleHome',
      'viewSectionPortal': 'tabRoleSection',
      'viewDepartmentPortal': 'tabRoleDept',
      'viewAdminLogin': 'tabRoleAdmin',
      'viewControlCenterWrapper': 'tabRoleAdmin',
      'viewOjtPortal': 'tabRoleOjt',
      'viewEmpLogin': 'tabRoleEmp',
      'viewEmpDashboard': 'tabRoleEmp',
      'viewEmpAssessment': 'tabRoleEmp',
      'viewEmpExams': 'tabRoleEmp'
    };
    const activeTabId = tabMap[viewId] || '';
    document.querySelectorAll('.role-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === activeTabId);
    });
  }
}

function updateUserBadge(name) {
  const badge = document.getElementById('navUserBadge');
  const avatar = document.getElementById('navAvatar');
  const nameSpan = document.getElementById('navUserName');
  const logoutBtn = document.getElementById('btnLogout');

  if (name) {
    badge.style.display = 'flex';
    logoutBtn.style.display = 'block';
 avatar.innerText = name.charAt(0).toUpperCase();
 nameSpan.innerText = name;
  } else {
    badge.style.display = 'none';
    logoutBtn.style.display = 'none';
  }
}

function togglePortalMode() {
  const hash = window.location.hash;
  if (hash.startsWith('#/control-center') || hash.startsWith('#/secure-control')) {
    navigateTo('/employee-portal');
  } else {
    navigateTo('/secure-control');
  }
}

// Employee Login
async function handleEmpLogin(e) {
  if (e) e.preventDefault();
  const empIdInput = document.getElementById('empIdInput');
  const passwordInput = document.getElementById('empPasswordInput');

  const empIdVal = empIdInput ? empIdInput.value.trim() : '';
  const passwordVal = passwordInput ? passwordInput.value.trim() : '';

  if (!empIdVal) {
    showToast('Please enter a valid Employee ID');
    return;
  }

  try {
    const res = await fetch('/api/auth/employee/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: empIdVal, password: passwordVal })
    });
    const data = await res.json();
    if (data.success && data.employee) {
      currentUser = data.employee;
      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({
        role: 'emp',
        empNo: data.employee.empNo,
        name: data.employee.name,
        section: data.employee.section,
        dept: data.employee.dept,
        currentLevel: data.employee.currentLevel,
        targetLevel: data.employee.targetLevel,
        token: data.token
      }));
      if (data.token) {
        localStorage.setItem('yokohama_emp_token', data.token);
      }
      updateUserBadge(data.employee.name);
      showToast(`Welcome, ${data.employee.name}!`);
      navigateTo('/employee/dashboard');
      return;
    } else {
      showToast(data.message || 'Invalid Employee ID or password');
      return;
    }
  } catch (err) {
    const emp = (typeof EMPLOYEES !== 'undefined' ? EMPLOYEES : []).find(e => e.empNo === empIdVal || e.empNo === '0' + empIdVal);
    if (emp) {
      currentUser = emp;
      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({ role: 'emp', empNo: emp.empNo }));
      updateUserBadge(emp.name);
      navigateTo('/employee/dashboard');
      return;
    }
    showToast('Employee ID not found or server offline!');
  }
}

// ---------------------------------------------------------------------
// Admin Mail ID + OTP Verification Handlers
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// 60-Second Integrity Admin Mail ID + OTP Verification Handlers
// ---------------------------------------------------------------------
let adminOtpState = {
  email: '',
  generatedOtp: '',
  expiresAt: null,
  timerInterval: null,
  secondsLeft: 60
};

function startOtpCountdownTimer() {
  if (adminOtpState.timerInterval) clearInterval(adminOtpState.timerInterval);
  adminOtpState.secondsLeft = 60;
  adminOtpState.expiresAt = Date.now() + 60000; // 60 seconds (1 minute) limit

  const timerEl = document.getElementById('otpTimerDisplay');
  const resendBtn = document.getElementById('btnResendOtp');

  if (resendBtn) {
    resendBtn.disabled = true;
 resendBtn.innerText = `Resend OTP in 60s`;
  }
 if (timerEl) timerEl.innerText = `60s`;

  adminOtpState.timerInterval = setInterval(() => {
    adminOtpState.secondsLeft--;

    if (adminOtpState.secondsLeft > 0) {
 if (timerEl) timerEl.innerText = `${adminOtpState.secondsLeft}s`;
 if (resendBtn) resendBtn.innerText = `Resend OTP in ${adminOtpState.secondsLeft}s`;
    } else {
      clearInterval(adminOtpState.timerInterval);
 if (timerEl) timerEl.innerText = `Expired`;
      if (resendBtn) {
        resendBtn.disabled = false;
 resendBtn.innerText = 'Resend New OTP';
      }
 showToast('OTP Code Expired (1-minute validity limit)! Click Resend OTP.');
    }
  }, 1000);
}
// ---------------------------------------------------------------------
// ADMIN AUTHENTICATION
// ---------------------------------------------------------------------
async function handleAdminLogin(e) {
  if (e) e.preventDefault();
  const usernameInput = document.getElementById('adminUsernameInput');
  const passwordInput = document.getElementById('adminPasswordInput');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!username || !password) {
    showToast('Please enter both admin username and password.');
    return;
  }

  // Authoritative server verification check
  try {
    const res = await fetch('/api/auth/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      const adminName = (data.admin && data.admin.name) ? data.admin.name : 'Administrator';
      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({
        role: 'admin',
        username: username,
        email: data.admin && data.admin.email ? data.admin.email : 'admin@yokohama.com',
        name: adminName
      }));
      updateUserBadge(adminName);
      showToast(`Authenticated successfully as ${adminName}`);
      navigateTo('/secure-control/dashboard');
    } else {
      showToast(data.message || 'Invalid username or password');
    }
  } catch (err) {
    showToast('Unable to connect to authentication server. Please check your network.');
  }
}

async function handleSendAdminOTP(e) {
  if (e) e.preventDefault();
  const emailInput = document.getElementById('adminEmailInput').value.trim();

  if (!emailInput || !emailInput.includes('@')) {
 showToast('Please enter a valid Admin Email ID');
    return;
  }

 showToast('Sending OTP to ' + emailInput + ' via Gmail SMTP...');

  try {
    const res = await fetch('/api/auth/admin/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput })
    });

    const data = await res.json();

    if (data.success) {
      adminOtpState.email = emailInput;

 document.getElementById('otpTargetEmail').innerText = emailInput;
      document.getElementById('adminEmailForm').style.display = 'none';
      document.getElementById('adminOtpForm').style.display = 'block';

      // Clear input so user MUST check Gmail inbox and enter OTP manually
      document.getElementById('adminOtpInput').value = '';
      document.getElementById('adminOtpInput').focus();

      startOtpCountdownTimer();

 showToast(data.message || 'OTP sent to your email inbox. Please check your Gmail and enter the 6-digit OTP.');
    } else {
 showToast('' + (data.message || 'Failed to send OTP'));
    }
  } catch (err) {
    console.error('API Error:', err);
 showToast('Could not connect to authentication server. Please check your network or server status.');
  }
}

function resendAdminOTP() {
  handleSendAdminOTP(null);
}

async function handleVerifyAdminOTP(e) {
  e.preventDefault();
  const otpEntered = document.getElementById('adminOtpInput').value.trim();
  const email = adminOtpState.email;

  if (!otpEntered || otpEntered.length !== 6) {
 showToast('Please enter the 6-digit OTP code received in your Gmail inbox');
    return;
  }

  try {
    const res = await fetch('/api/auth/admin/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, otp: otpEntered })
    });

    const data = await res.json();

    if (data.success) {
      if (adminOtpState.timerInterval) clearInterval(adminOtpState.timerInterval);

      const adminName = data.admin && data.admin.name ? data.admin.name : 'Reuben Geoffrey (Superadmin)';

      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({ role: 'admin', email: email, name: adminName }));
      updateUserBadge(adminName);
 showToast(`Authenticated successfully as ${adminName}`);
      navigateTo('/secure-control/dashboard');
    } else {
 showToast(`${data.message || 'Verification failed: Incorrect OTP code'}`);
    }
  } catch (err) {
    console.error('API Error:', err);
 showToast('Verification error. Please try again.');
  }
}

function resetAdminOtpForm() {
  if (adminOtpState.timerInterval) clearInterval(adminOtpState.timerInterval);
  document.getElementById('adminOtpForm').style.display = 'none';
  document.getElementById('adminEmailForm').style.display = 'block';
  document.getElementById('adminOtpInput').value = '';
}

// Logout
async function logout() {
  if (timerInterval) clearInterval(timerInterval);
  try {
    const headers = getAuthHeaders();
    await Promise.allSettled([
      fetch('/api/auth/admin/logout', { method: 'POST', headers }),
      fetch('/api/auth/employee/logout', { method: 'POST', headers })
    ]);
  } catch (e) {
    console.error(e);
  }
  localStorage.removeItem(STORAGE_KEY_SESSION);
  localStorage.removeItem('yokohama_emp_token');
  currentUser = null;
  activeExam = null;
  navigateTo('/');
}

// ---------------------------------------------------------------------
// EMPLOYEE VIEWS (/employee/*)
// ---------------------------------------------------------------------
function showEmpDashboard() {
  if (!currentUser) return;

  const currentLevel = (currentUser.currentLevel || 'L').toUpperCase().trim();
  const currentRules = LEVEL_RULES[currentLevel] || LEVEL_RULES['L'];
  const targetLevel = (currentRules && currentRules.nextLevel) ? currentRules.nextLevel : (currentLevel === 'L' ? 'U' : (currentLevel === 'U' ? 'O' : 'O'));
  const targetRules = LEVEL_RULES[targetLevel] || LEVEL_RULES['U'];

  currentUser.targetLevel = targetLevel;

  // Profile fields
  const elEmpNo = document.getElementById('infoEmpNo');
  if (elEmpNo) elEmpNo.innerText = currentUser.empNo;
  const elEmpName = document.getElementById('infoEmpName');
  if (elEmpName) elEmpName.innerText = currentUser.name;
  const elEmpDept = document.getElementById('infoEmpDept');
  if (elEmpDept) elEmpDept.innerText = `${currentUser.section || 'Tire building QA'} (${currentUser.dept || 'QUALITY CONTROL'})`;
  const elEmpDoj = document.getElementById('infoEmpDoj');
  if (elEmpDoj) elEmpDoj.innerText = currentUser.doj || 'N/A';
  
  const elCurrentLvlBadge = document.getElementById('infoCurrentLevelBadge');
  if (elCurrentLvlBadge) {
    elCurrentLvlBadge.innerText = currentLevel;
    elCurrentLvlBadge.className = `iluo-badge iluo-badge-${currentLevel.toLowerCase()}`;
  }
  const elCurrentLvlText = document.getElementById('infoCurrentLevelText');
  if (elCurrentLvlText) {
    const levelNames = { 'I': 'Level I (Beginner)', 'L': 'Level L (Learner)', 'U': 'Level U (Executor)', 'O': 'Level O (Expert)' };
    elCurrentLvlText.innerText = levelNames[currentLevel] || `Level ${currentLevel}`;
  }

  // Re-assessment Due Date: 6 months from DOJ or exam
  const elDueDate = document.getElementById('infoDueDate');
  if (elDueDate) {
    const baseDate = currentUser.doj ? new Date(currentUser.doj) : new Date();
    baseDate.setMonth(baseDate.getMonth() + 6);
    elDueDate.innerText = baseDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const elTargetLevel = document.getElementById('infoTargetLevel');
  if (elTargetLevel) elTargetLevel.innerText = `${targetLevel} Level (${targetRules.numQuestions || 30} Qs)`;

  // Fetch assessment records
  const records = getStoredRecords();
  const rec = records[currentUser.empNo];
  const ojtRecords = (typeof getStoredOjtRecords === 'function') ? getStoredOjtRecords() : {};
  const ojtRec = ojtRecords[currentUser.empNo];

  // Knowledge Test Status & Marks (STRICTLY MARKS ONLY, NO %)
  const elKnowledgeBadge = document.getElementById('empKnowledgeStatusBadge');
  const elKnowledgeScore = document.getElementById('empKnowledgeScoreText');
  if (rec && rec.isCompleted) {
    const totalQ = rec.submittedQuestions ? rec.submittedQuestions.length : (targetRules.numQuestions || 20);
    const marks = rec.totalMark !== undefined ? rec.totalMark : (rec.submittedQuestions ? rec.submittedQuestions.filter(q => q.isCorrect).length : 0);
    const isPass = rec.status === 'Passed' || marks >= Math.ceil(totalQ * 0.7);
    if (elKnowledgeBadge) {
      elKnowledgeBadge.innerText = isPass ? 'Qualified' : 'Retest Required';
      elKnowledgeBadge.style.background = isPass ? '#ECFDF5' : '#FEF2F2';
      elKnowledgeBadge.style.color = isPass ? '#059669' : '#DC2626';
    }
    if (elKnowledgeScore) {
      elKnowledgeScore.innerText = `${marks} / ${totalQ} Marks`;
      elKnowledgeScore.style.color = isPass ? '#059669' : '#DC2626';
    }
  } else {
    if (elKnowledgeBadge) {
      elKnowledgeBadge.innerText = rec && rec.inProgress ? 'In Progress' : 'Pending';
      elKnowledgeBadge.style.background = '#EFF6FF';
      elKnowledgeBadge.style.color = '#1D4ED8';
    }
    if (elKnowledgeScore) elKnowledgeScore.innerText = 'Pending Exam';
  }

  // OJT Practical Evaluation Status & Marks (MARKS ONLY)
  const elOjtBadge = document.getElementById('empOjtStatusBadge');
  const elOjtScore = document.getElementById('empOjtScoreText');
  if (ojtRec && ojtRec.isCompleted) {
    const ojtTotal = ojtRec.totalPossibleMarks || 20;
    const ojtMarks = ojtRec.totalScore !== undefined ? ojtRec.totalScore : 0;
    if (elOjtBadge) {
      elOjtBadge.innerText = 'Completed';
      elOjtBadge.style.background = '#ECFDF5';
      elOjtBadge.style.color = '#059669';
    }
    if (elOjtScore) elOjtScore.innerText = `${ojtMarks} / ${ojtTotal} Marks`;
  } else {
    if (elOjtBadge) {
      elOjtBadge.innerText = 'Pending';
      elOjtBadge.style.background = '#FEF3C7';
      elOjtBadge.style.color = '#D97706';
    }
    if (elOjtScore) elOjtScore.innerText = 'Pending Evaluation';
  }

  // Result & Promoted Skill Level
  const elOverall = document.getElementById('empOverallStatusText');
  const elPromoted = document.getElementById('empPromotedSkillBadge');
  const isKnowledgePass = rec && (rec.status === 'Passed' || (rec.totalMark !== undefined && rec.totalMark >= 14));
  const isOjtDone = ojtRec && ojtRec.isCompleted;

  if (isKnowledgePass && isOjtDone) {
    if (elOverall) elOverall.innerText = `QUALIFIED FOR LEVEL ${targetLevel}`;
    if (elPromoted) {
      elPromoted.style.display = 'inline-block';
      elPromoted.innerText = `Promoted: ${currentLevel} ➔ ${targetLevel}`;
    }
  } else if (isKnowledgePass) {
    if (elOverall) elOverall.innerText = 'Knowledge Test Qualified • OJT Pending';
    if (elPromoted) elPromoted.style.display = 'none';
  } else if (rec && rec.isCompleted) {
    if (elOverall) elOverall.innerText = 'Retest Required for Knowledge Assessment';
    if (elPromoted) elPromoted.style.display = 'none';
  } else {
    if (elOverall) elOverall.innerText = 'Assessments Pending';
    if (elPromoted) elPromoted.style.display = 'none';
  }

  // Training Plan Milestones
  const stepI = document.getElementById('planStepI');
  const stepL = document.getElementById('planStepL');
  const stepU = document.getElementById('planStepU');
  const stepO = document.getElementById('planStepO');
  const actualL = document.getElementById('planActualL');
  const actualU = document.getElementById('planActualU');
  const actualO = document.getElementById('planActualO');

  if (currentLevel === 'I') {
    if (stepI) stepI.className = 'timeline-step current';
    if (stepL) stepL.className = 'timeline-step';
    if (stepU) stepU.className = 'timeline-step';
    if (stepO) stepO.className = 'timeline-step';
  } else if (currentLevel === 'L') {
    if (stepI) stepI.className = 'timeline-step completed';
    if (stepL) {
      stepL.className = isKnowledgePass ? 'timeline-step completed' : 'timeline-step current';
      if (actualL) actualL.innerHTML = isKnowledgePass ? '<strong>Actual:</strong> Completed &check;' : '<strong>Actual:</strong> In Assessment';
    }
    if (stepU) {
      stepU.className = isKnowledgePass ? 'timeline-step current' : 'timeline-step';
      if (actualU) actualU.innerHTML = isKnowledgePass ? '<strong>Actual:</strong> Next Target' : '<strong>Actual:</strong> Scheduled';
    }
    if (stepO) stepO.className = 'timeline-step';
  } else if (currentLevel === 'U') {
    if (stepI) stepI.className = 'timeline-step completed';
    if (stepL) stepL.className = 'timeline-step completed';
    if (stepU) {
      stepU.className = isKnowledgePass ? 'timeline-step completed' : 'timeline-step current';
      if (actualU) actualU.innerHTML = isKnowledgePass ? '<strong>Actual:</strong> Completed &check;' : '<strong>Actual:</strong> In Assessment';
    }
    if (stepO) {
      stepO.className = isKnowledgePass ? 'timeline-step current' : 'timeline-step';
      if (actualO) actualO.innerHTML = isKnowledgePass ? '<strong>Actual:</strong> Next Target' : '<strong>Actual:</strong> Future Goal';
    }
  } else if (currentLevel === 'O') {
    if (stepI) stepI.className = 'timeline-step completed';
    if (stepL) stepL.className = 'timeline-step completed';
    if (stepU) stepU.className = 'timeline-step completed';
    if (stepO) {
      stepO.className = 'timeline-step completed';
      if (actualO) actualO.innerHTML = '<strong>Actual:</strong> Master Expert &check;';
    }
  }

  showView('viewEmpDashboard');
}

async function downloadCurrentEmployeeDocx() {
  let empNo = (currentUser && currentUser.empNo) ? currentUser.empNo : null;
  if (!empNo) {
    try {
      const s = localStorage.getItem(STORAGE_KEY_SESSION);
      if (s) empNo = JSON.parse(s)?.empNo;
    } catch (e) {}
  }
  if (!empNo) {
    showToast('Please sign in to download your report.');
    return;
  }
  showToast('Generating official DOCX report with mapped answer ticks...');
  try {
    await downloadEmployeeDocx(empNo);
  } catch (err) {
    console.error('DOCX download error:', err);
    showToast('Failed to download DOCX: ' + err.message);
  }
}

async function downloadCurrentEmployeePDF() {
  let empNo = (currentUser && currentUser.empNo) ? currentUser.empNo : null;
  if (!empNo) {
    try {
      const s = localStorage.getItem(STORAGE_KEY_SESSION);
      if (s) empNo = JSON.parse(s)?.empNo;
    } catch (e) {}
  }
  if (!empNo) {
    showToast('Please sign in to download your PDF report.');
    return;
  }
  showToast('Generating official PDF report...');
  try {
    await downloadEmployeePDF(empNo);
  } catch (err) {
    console.error('PDF download error:', err);
    showToast('Failed to download PDF: ' + err.message);
  }
}

function showEmpExamsView() {
  if (!currentUser) return;
  showView('viewEmpExams');
  
  const currentLevel = currentUser.currentLevel || 'I';
  const currentRules = LEVEL_RULES[currentLevel] || LEVEL_RULES['I'];
  const targetLevel = currentRules.nextLevel;
  const targetRules = LEVEL_RULES[targetLevel] || LEVEL_RULES['L'];

  const records = getStoredRecords();
  const rec = records[currentUser.empNo];

  const container = document.getElementById('empExamListContainer');
  
  if (rec && rec.isCompleted) {
    container.innerHTML = `
      <div class="info-item" style="border-left: 4px solid var(--success-color);">
        <div style="font-weight: 700; font-size: 1.1rem;">Level ${targetLevel} MCQ Assessment</div>
        <div style="font-size: 0.88rem; color: var(--text-muted); margin: 6px 0;">Status: <strong>${rec.status}</strong> | Score: <strong>${rec.totalMark !== undefined ? rec.totalMark : 0} Marks</strong></div>
        <div style="font-size: 0.8rem; color: var(--success-color); font-weight: 600;">✔ Completed on ${rec.attemptDate}</div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="info-item" style="border-left: 4px solid var(--primary-color);">
        <div style="font-weight: 700; font-size: 1.1rem;">Level ${targetLevel} MCQ Assessment</div>
        <div style="font-size: 0.88rem; color: var(--text-muted); margin: 6px 0;">Questions: ${targetRules.numQuestions} | Time Allowed: 45 Mins | Passing: >${targetRules.passingPct}%</div>
        <button class="btn-primary" style="max-width: 220px; margin-top: 12px;" onclick="startOrResumeExam()">
          ${rec && rec.inProgress ? 'Resume Assessment ➔' : 'Start Assessment ➔'}
        </button>
      </div>
    `;
  }
}

function showEmpResultsView() {
  if (!currentUser) return;
  const records = getStoredRecords();
  const record = records[currentUser.empNo] || {};

  showResultView(record);
}

function showEmpProfileView() {
  if (!currentUser) return;
  showView('viewEmpProfile');

  const grid = document.getElementById('profInfoGrid');
  grid.innerHTML = `
    <div class="info-item">
      <div class="label">Employee ID</div>
      <div class="value">${currentUser.empNo}</div>
    </div>
    <div class="info-item">
      <div class="label">Full Name</div>
      <div class="value">${currentUser.name}</div>
    </div>
    <div class="info-item">
      <div class="label">Department</div>
      <div class="value">${currentUser.dept}</div>
    </div>
    <div class="info-item">
      <div class="label">Section</div>
      <div class="value">${currentUser.section || 'Tire Building QA'}</div>
    </div>
    <div class="info-item">
      <div class="label">Qualification</div>
      <div class="value">${currentUser.qualification || 'N/A'}</div>
    </div>
    <div class="info-item">
      <div class="label">Date of Joining (DOJ)</div>
      <div class="value">${currentUser.doj || 'N/A'}</div>
    </div>
    <div class="info-item">
      <div class="label">Current Skill Level</div>
      <div class="value" style="color: var(--primary-color); font-weight: 800;">${currentUser.currentLevel || 'I'} Level</div>
    </div>
  `;
}

function normalizeSectionName(sec) {
  let s = (sec || '').toLowerCase().trim();
  s = s.replace(/\s+/g, ' ');
  s = s.replace('ware house', 'warehouse');
  if (s.includes('rro') || s.includes('alt')) return 'final finish rro & alt qa';
  if (s.includes('building') || s.includes('tbm')) return 'tire building qa';
  if (s.includes('curing')) return 'tire curing qa';
  if (s.includes('solid')) return 'solid tire qa';
  if (s.includes('preparatory')) return 'preparatory qa';
  if (s.includes('fid')) return 'fid inspector qa';
  if (s.includes('warehouse') || s.includes('data entry')) return 'warehouse qa';
  if (s.includes('finish')) return 'final finish qa';
  return s;
}

function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Section-based Question Selection (Balanced Sequence across Safety, CI & TPM, and QA & Process)
function getQuestionsForSection(targetLevel, section) {
  const allLevelQuestions = QUESTION_BANK[targetLevel] || QUESTION_BANK['L'] || [];
  const rules = LEVEL_RULES[targetLevel] || LEVEL_RULES['L'] || { numQuestions: 40 };
  const requiredCount = rules.numQuestions || 40;

  if (!section) return allLevelQuestions.slice(0, requiredCount);

  const empSecNorm = normalizeSectionName(section);

  // Filter questions matching employee section
  const sectionQs = allLevelQuestions.filter(q => normalizeSectionName(q.section) === empSecNorm);

  if (sectionQs.length === 0) {
    return allLevelQuestions.slice(0, requiredCount);
  }

  // Group by category to ensure Technical / QA & Process questions are included
  const byCategory = {};
  sectionQs.forEach(q => {
    const cat = q.category || 'General';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(q);
  });

  const categories = Object.keys(byCategory);
  const numCats = categories.length;

  if (numCats <= 1) return sectionQs.slice(0, requiredCount);

  const baseTarget = Math.floor(requiredCount / numCats);
  const extraSlots = requiredCount % numCats;

  const selected = [];
  categories.forEach((cat, idx) => {
    const targetForCat = baseTarget + (idx < extraSlots ? 1 : 0);
    selected.push(...byCategory[cat].slice(0, targetForCat));
  });

  if (selected.length < requiredCount) {
    const selectedIds = new Set(selected.map(q => q.id));
    const remainingSectionQs = sectionQs.filter(q => !selectedIds.has(q.id));
    selected.push(...remainingSectionQs.slice(0, requiredCount - selected.length));
  }

  return selected.slice(0, requiredCount);
}

// Start or Resume Exam
async function startOrResumeExam() {
  if (!currentUser) return;

  const targetLevel = currentUser.targetLevel || 'L';
  const records = getStoredRecords();
  let empRecord = records[currentUser.empNo];

  // Try starting / resuming via secure server exam session
  try {
    const res = await fetch('/api/exam/start', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ empNo: currentUser.empNo, targetLevel })
    });
    const data = await res.json();
    if (res.status === 409 && data.record) {
      showToast('Assessment already completed for this candidate.');
      showResultView(data.record, false);
      return;
    }
    if (data.success && data.activeExam) {
      const serverExam = data.activeExam;
      const remSecs = serverExam.expiresAt
        ? Math.max(10, Math.floor((serverExam.expiresAt - Date.now()) / 1000))
        : (45 * 60);

      activeExam = {
        empNo: currentUser.empNo,
        targetLevel: targetLevel,
        questions: serverExam.questions,
        currentIndex: 0,
        responses: {},
        remainingSeconds: remSecs,
        tabSwitchCount: 0,
        isCompleted: false
      };

      navigateTo(`/employee/exam/${targetLevel}`);
      updateTabWarningBadge();
      renderCurrentQuestion();
      startTimer();
      return;
    }
  } catch (err) {
    console.warn('Server exam start unreachable, using local fallback:', err.message);
  }

  // Fallback offline / local handling with sanitized questions
  const sectionQuestions = getQuestionsForSection(targetLevel, currentUser.section);
  const sanitizedLocalQs = sectionQuestions.map(q => {
    const { correctAnswer, ...rest } = q;
    return rest;
  });

  if (empRecord && empRecord.inProgress && !empRecord.isCompleted) {
    activeExam = {
      empNo: currentUser.empNo,
      targetLevel: targetLevel,
      questions: empRecord.questions || sanitizedLocalQs,
      currentIndex: empRecord.currentIndex || 0,
      responses: empRecord.responses || {},
      remainingSeconds: empRecord.remainingSeconds || (45 * 60),
      tabSwitchCount: empRecord.tabSwitchCount || 0,
      isCompleted: false
    };
    showToast('Resuming active assessment...');
  } else {
    activeExam = {
      empNo: currentUser.empNo,
      targetLevel: targetLevel,
      questions: sanitizedLocalQs,
      currentIndex: 0,
      responses: {},
      remainingSeconds: 45 * 60,
      tabSwitchCount: 0,
      isCompleted: false
    };

    saveRecord(currentUser.empNo, {
      empNo: currentUser.empNo,
      name: currentUser.name,
      dept: currentUser.dept,
      section: currentUser.section,
      doj: currentUser.doj,
      targetLevel: targetLevel,
      inProgress: true,
      isCompleted: false,
      questions: activeExam.questions,
      currentIndex: 0,
      responses: {},
      remainingSeconds: activeExam.remainingSeconds,
      tabSwitchCount: 0,
      startedAt: new Date().toISOString()
    });
  }

  navigateTo(`/employee/exam/${targetLevel}`);
  updateTabWarningBadge();
  renderCurrentQuestion();
  startTimer();
}

// Timer Engine
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  updateTimerDisplay();

  timerInterval = setInterval(() => {
    if (!activeExam || activeExam.isCompleted) {
      clearInterval(timerInterval);
      return;
    }

    activeExam.remainingSeconds--;

    if (activeExam.remainingSeconds % 5 === 0) {
      saveRecord(activeExam.empNo, {
        remainingSeconds: activeExam.remainingSeconds,
        currentIndex: activeExam.currentIndex,
        responses: activeExam.responses,
        tabSwitchCount: activeExam.tabSwitchCount
      });
    }

    updateTimerDisplay();

    if (activeExam.remainingSeconds <= 0) {
      clearInterval(timerInterval);
 showToast('Time expired! Submitting assessment...');
      submitAssessment();
    }
  }, 1000);
}

function updateTimerDisplay() {
  if (!activeExam) return;
  const mins = Math.floor(activeExam.remainingSeconds / 60);
  const secs = activeExam.remainingSeconds % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
 document.getElementById('timerDisplay').innerText = formatted;
}

// Question Renderer
function renderCurrentQuestion() {
  if (!activeExam) return;

  const totalQs = activeExam.questions.length;
  const qIndex = activeExam.currentIndex;

  if (qIndex >= totalQs) {
    submitAssessment();
    return;
  }

  const q = activeExam.questions[qIndex];

 document.getElementById('quizProgressText').innerText = `Question ${qIndex + 1} of ${totalQs}`;
 document.getElementById('quizSubText').innerText = `Target: Level ${activeExam.targetLevel} Assessment`;
 document.getElementById('qCategoryTag').innerText = q.category || 'QA & Safety';
 document.getElementById('qTitleText').innerText = q.question;

  const container = document.getElementById('optionsContainer');
  container.innerHTML = '';

  const selectedOpt = activeExam.responses[q.id];

  q.options.forEach(opt => {
    const optDiv = document.createElement('div');
    optDiv.className = `option-item ${selectedOpt === opt.key ? 'selected' : ''}`;
    optDiv.onclick = () => selectOption(opt.key);

    optDiv.innerHTML = `
      <div class="option-key">${opt.key}</div>
      <div class="option-text">${opt.text}</div>
    `;

    container.appendChild(optDiv);
  });

  const nextBtn = document.getElementById('btnNextQ');
  if (qIndex === totalQs - 1) {
    nextBtn.innerText = 'Submit Assessment';
  } else {
    nextBtn.innerText = 'Next Question';
  }

  nextBtn.disabled = !selectedOpt;
}

function selectOption(key) {
  if (!activeExam) return;
  const q = activeExam.questions[activeExam.currentIndex];
  activeExam.responses[q.id] = key;

  renderCurrentQuestion();

  saveRecord(activeExam.empNo, {
    currentIndex: activeExam.currentIndex,
    responses: activeExam.responses
  });
}

function nextQuestion() {
  if (!activeExam) return;
  const totalQs = activeExam.questions.length;

  if (activeExam.currentIndex < totalQs - 1) {
    activeExam.currentIndex++;
    saveRecord(activeExam.empNo, {
      currentIndex: activeExam.currentIndex,
      responses: activeExam.responses
    });
    renderCurrentQuestion();
  } else {
    submitAssessment();
  }
}

// Submit & Scoring Engine (Authoritative Server-Side Scoring)
async function submitAssessment() {
  if (timerInterval) clearInterval(timerInterval);
  if (!activeExam) return;

  activeExam.isCompleted = true;
  showToast('Submitting assessment for official server evaluation...');

  try {
    const res = await fetch('/api/exam/submit', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        empNo: currentUser.empNo,
        targetLevel: activeExam.targetLevel,
        responses: activeExam.responses
      })
    });
    const data = await res.json();
    if (data.success && data.record) {
      const recordData = data.record;
      window.lastCompletedEmpNo = currentUser.empNo;
      const records = getStoredRecords();
      records[currentUser.empNo] = recordData;
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));
      showResultView(recordData, true);
      return;
    } else {
      showToast(data.message || 'Error submitting assessment to server');
    }
  } catch (err) {
    console.error('Server submission failed:', err);
    showToast('Failed to submit to server. Checking network connection...');
  }
}

function showResultView(record, isImmediateCompletion = false) {
  if (record && record.empNo) window.lastCompletedEmpNo = record.empNo;
  else if (currentUser && currentUser.empNo) window.lastCompletedEmpNo = currentUser.empNo;
  
  document.getElementById('resAttempted').innerText = `${record.attemptedCount || 0} Questions`;
  
  const totalMarks = record.totalMark !== undefined ? record.totalMark : (record.lMark || record.uMark || record.oMark || 0);
  const qCount = record.submittedQuestions ? record.submittedQuestions.length : (record.targetLevel === 'L' ? 20 : (record.targetLevel === 'U' ? 30 : 40));
  
  const resMarksEl = document.getElementById('resMarks');
 if (resMarksEl) resMarksEl.innerText = `${totalMarks} / ${qCount} Marks`;

  const resPctEl = document.getElementById('resPct');
  const minPassBenchmark = Math.ceil(qCount * 0.7);
  if (resPctEl) resPctEl.innerText = `${minPassBenchmark} / ${qCount} Marks`;

  const statusEl = document.getElementById('resStatus');
  statusEl.innerText = record.status || 'Completed';
  
  if (record.status && record.status.includes('Terminated')) {
    statusEl.style.color = 'var(--accent-red)';
  } else {
    statusEl.style.color = record.status === 'Passed' ? 'var(--success-color)' : 'var(--accent-red)';
  }

  // Handle One-Time Answer Review Container
  const reviewContainer = document.getElementById('oneTimeAnswerReviewContainer');
  if (reviewContainer) {
    reviewContainer.innerHTML = '';
    
    if (record.submittedQuestions && record.submittedQuestions.length > 0) {
      let html = `
        <h3 style="font-size: 1.1rem; color: var(--primary-dark); margin-bottom: 12px; border-bottom: 1.5px solid var(--border-color); padding-bottom: 6px;">
          Question Review &amp; Official Key Audit
        </h3>
      `;

      record.submittedQuestions.forEach((q, idx) => {
        const isCorr = q.isCorrect;
        const borderCol = isCorr ? 'var(--success-color)' : 'var(--accent-red)';
        const badgeBg = isCorr ? '#ECFDF5' : '#FEF2F2';
        const badgeCol = isCorr ? '#065F46' : '#991B1B';

        html += `
          <div style="background: #FFFFFF; border: 1px solid var(--border-color); border-left: 4px solid ${borderCol}; border-radius: 6px; padding: 12px 14px; margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
              <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-main);">
                <span style="color: var(--primary-color);">Q${idx + 1}.</span> [${q.category || 'QA'}] ${q.question}
              </div>
              <span style="font-size: 0.75rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: ${badgeBg}; color: ${badgeCol};">
                ${isCorr ? 'Correct (1 Mark)' : 'Incorrect (0 Marks)'}
              </span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.85rem; margin-top: 6px;">
              <div style="background: ${isCorr ? '#F0FDF4' : '#FFF1F2'}; padding: 6px 10px; border-radius: 4px;">
                <strong>Your Answer:</strong> [${q.selectedKey}] ${q.selectedText}
              </div>
              <div style="background: #F8FAFC; padding: 6px 10px; border-radius: 4px;">
                <strong>Correct Key:</strong> [${q.correctKey}] ${q.correctText}
              </div>
            </div>
          </div>
        `;
      });

      reviewContainer.innerHTML = html;
    }
  }

  showView('viewResult');
}

// ---------------------------------------------------------------------
// CONTROL CENTER VIEWS (/control-center/*)
// ---------------------------------------------------------------------
function showControlCenterSubView(subName) {
  showView('viewControlCenterWrapper');

  // Normalize alias
  if (subName === 'export') subName = 'reports';
  if (subName === 'training-requirements' || subName === 'training-requirement') subName = 'training';

  // Highlight active sidebar link
  document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
  document.querySelectorAll('.control-subview').forEach(sub => sub.style.display = 'none');

  const targetSidebarLink = document.getElementById(`navCtrl${capitalize(subName)}`);
  if (targetSidebarLink) targetSidebarLink.classList.add('active');

  const targetSubView = document.getElementById(`ctrlSub${capitalize(subName)}`);
  if (targetSubView) targetSubView.style.display = 'block';

  // Render sub-view data
  if (subName === 'dashboard') renderAdminDashboard();
  else if (subName === 'questions') renderQuestionsManager();
  else if (subName === 'sections') renderSectionsExplorer();
  else if (subName === 'exams') {
    if (typeof updateAdminResetSecInfo === 'function') updateAdminResetSecInfo();
    if (typeof updateAdminResetDeptInfo === 'function') updateAdminResetDeptInfo();
  }
  else if (subName === 'employees') renderEmployeeDirectory();
  else if (subName === 'results') renderAdminTable('');
  else if (subName === 'reports') renderReportsCenter();
  else if (subName === 'training') renderTrainingRequirements();
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Admin Dashboard Analytics
function renderAdminDashboard() {
  const records = getStoredRecords();
  const allOjt = getStoredOjtRecords();
  const allEmps = EMPLOYEES;

  let completedCount = 0;
  let inProgressCount = 0;
  let ojtCompletedCount = 0;

  allEmps.forEach(emp => {
    const rec = records[emp.empNo];
    if (rec && rec.isCompleted) completedCount++;
    else if (rec && rec.inProgress) inProgressCount++;

    const ojt = allOjt[emp.empNo];
    if (ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined)) {
      ojtCompletedCount++;
    }
  });

  const notStartedCount = allEmps.length - completedCount - inProgressCount;

  if (document.getElementById('statTotalEmp')) document.getElementById('statTotalEmp').innerText = allEmps.length;
  if (document.getElementById('statCompleted')) document.getElementById('statCompleted').innerText = completedCount;
  if (document.getElementById('statInProgress')) document.getElementById('statInProgress').innerText = inProgressCount;
  if (document.getElementById('statNotStarted')) document.getElementById('statNotStarted').innerText = notStartedCount;
  if (document.getElementById('statOjtCompleted')) document.getElementById('statOjtCompleted').innerText = ojtCompletedCount;

  renderPieChart(completedCount, inProgressCount, notStartedCount);
  renderBarChart(records);
  renderDashboardSectionMatrix(records, allOjt);
}

function renderDashboardSectionMatrix(records, allOjt) {
  const tbody = document.getElementById('dashboardSectionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  QA_SECTIONS_LIST.forEach((sec, idx) => {
    const emps = EMPLOYEES.filter(e => normalizeSectionName(e.section) === sec.normName);
    const total = emps.length;

    let examDone = 0;
    let ojtDone = 0;
    let bothDone = 0;

    emps.forEach(e => {
      const rec = records[e.empNo];
      const ojt = allOjt[e.empNo];
      const hasExam = rec && rec.isCompleted;
      const hasOjt = ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined);

      if (hasExam) examDone++;
      if (hasOjt) ojtDone++;
      if (hasExam && hasOjt) bothDone++;
    });

    const completionPct = total > 0 ? Math.round((bothDone / total) * 100) : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
      <td>
        <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">${sec.title}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${sec.code} Section &bull; ${sec.name}</div>
      </td>
      <td style="text-align: center; font-weight: 700;">${total}</td>
      <td style="text-align: center;">
        <span class="${examDone > 0 ? 'badge-pass' : ''}" style="display: inline-block; padding: 3px 8px; font-weight: 700; font-size: 0.8rem;">
          ${examDone} / ${total}
        </span>
      </td>
      <td style="text-align: center;">
        <span class="${ojtDone > 0 ? 'badge-pass' : ''}" style="display: inline-block; padding: 3px 8px; font-weight: 700; font-size: 0.8rem; background: ${ojtDone > 0 ? '#DCFCE7' : '#F1F5F9'}; color: ${ojtDone > 0 ? '#166534' : '#64748B'};">
          ${ojtDone} / ${total}
        </span>
      </td>
      <td style="text-align: center;">
        <span style="display: inline-block; padding: 3px 8px; font-weight: 800; font-size: 0.82rem; background: ${bothDone > 0 ? '#DBEAFE' : '#F8FAFC'}; color: ${bothDone > 0 ? '#1E40AF' : '#94A3B8'}; border-radius: 6px;">
          ${bothDone} / ${total}
        </span>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="flex: 1; background: #E2E8F0; height: 8px; border-radius: 4px; overflow: hidden;">
            <div style="width: ${completionPct}%; background: #059669; height: 100%; border-radius: 4px; transition: width 0.3s ease;"></div>
          </div>
          <span style="font-size: 0.76rem; font-weight: 700; color: #0F172A; min-width: 50px; text-align: right;">${bothDone} Done</span>
        </div>
      </td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;">
          <button type="button" class="btn-primary" style="padding: 4px 10px; font-size: 0.76rem; background: #005B9E; border-color: #005B9E;" onclick="showSectionCompletedModal('${sec.id}')">
            View List
          </button>
          <button type="button" class="btn-secondary" style="padding: 4px 8px; font-size: 0.76rem;" onclick="navigateTo('/control-center/sections'); renderSectionsExplorer('${sec.id}');">
            Explorer
          </button>
          <button type="button" class="btn-reset" style="padding: 4px 8px; font-size: 0.74rem;" onclick="resetSectionExams('${sec.id}', '${sec.title.replace(/'/g, "\\'")}')" title="Reset all candidate exams for ${sec.title}">
            Reset
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

let currentModalSectionId = null;
let currentModalFilterType = 'ALL';

function showSectionCompletedModal(secId, filterType = 'ALL') {
  currentModalSectionId = secId;
  currentModalFilterType = filterType;

  const sec = QA_SECTIONS_LIST.find(s => s.id === secId) || QA_SECTIONS_LIST[0];
  const modal = document.getElementById('modalSectionCompleted');
  if (!modal) return;

  const titleEl = document.getElementById('modalSecTitle');
  if (titleEl) titleEl.innerText = `${sec.title} - Completion Details`;

  const subEl = document.getElementById('modalSecSubtitle');
  if (subEl) subEl.innerText = `Detailed employee scores for MCQ assessment and OJT practical evaluations in ${sec.title}`;

  filterModalEmployees(currentModalFilterType);

  modal.style.display = 'flex';
  modal.classList.add('active');
  modal.scrollTop = 0;
}

function closeSectionCompletedModal() {
  const modal = document.getElementById('modalSectionCompleted');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function filterModalEmployees(type) {
  currentModalFilterType = type;

  ['All', 'Exam', 'Ojt', 'Both'].forEach(k => {
    const btn = document.getElementById(`filterModal${k}Btn`);
    if (btn) {
      if (type.toUpperCase() === k.toUpperCase()) {
        btn.className = 'btn-primary';
      } else {
        btn.className = 'btn-secondary';
      }
    }
  });

  const sec = QA_SECTIONS_LIST.find(s => s.id === currentModalSectionId) || QA_SECTIONS_LIST[0];
  const sectionEmps = EMPLOYEES.filter(e => normalizeSectionName(e.section) === sec.normName);
  const records = getStoredRecords();
  const allOjt = getStoredOjtRecords();

  const filtered = sectionEmps.filter(e => {
    const rec = records[e.empNo];
    const ojt = allOjt[e.empNo];
    const hasExam = rec && rec.isCompleted;
    const hasOjt = ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined);

    if (type === 'EXAM') return hasExam;
    if (type === 'OJT') return hasOjt;
    if (type === 'BOTH') return hasExam && hasOjt;
    return true; // ALL
  });

  const countEl = document.getElementById('modalEmpCount');
  if (countEl) countEl.innerText = `${filtered.length} Employees (${type === 'ALL' ? 'Total' : type + ' Done'})`;

  const tbody = document.getElementById('modalCompletedEmpsBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 28px; color: var(--text-muted);">
          No employees found for filter "${type}" in ${sec.title}.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach((emp, idx) => {
    const rec = records[emp.empNo] || {};
    const ojt = allOjt[emp.empNo] || {};

    const hasExam = rec.isCompleted;
    const hasOjt = ojt.totalScore !== undefined || ojt.scorePct !== undefined;

    // RAW MARKS ONLY - NO PERCENTAGE (%) PER USER REQUIREMENT
    const examMarkDisplay = hasExam ? `${rec.totalMark !== undefined ? rec.totalMark : 0} Marks` : (rec.inProgress ? 'In Progress' : 'Not Started');
    const ojtMarkDisplay = hasOjt ? `${ojt.totalScore !== undefined ? ojt.totalScore : 0}/${ojt.maxScore || 50} Marks` : 'Pending';

    const examPassed = rec.status === 'Passed' || (rec.markPct !== undefined && rec.markPct >= 70);
    const ojtPassed = ojt.qualificationStatus === 'Qualified' || (ojt.scorePct !== undefined && ojt.scorePct >= 70);

    let statusHtml = '';
    if (hasExam && hasOjt) {
      if (examPassed && ojtPassed) {
        statusHtml = `<span class="badge-pass">Fully Qualified</span>`;
      } else {
        statusHtml = `<span class="badge-fail">Needs Retest</span>`;
      }
    } else if (hasExam) {
      statusHtml = `<span style="background: #EFF6FF; color: #1E40AF; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">${rec.status || 'Exam Completed'}</span>`;
    } else if (hasOjt) {
      statusHtml = `<span style="background: #ECFDF5; color: #065F46; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">OJT ${ojt.qualificationStatus || 'Done'}</span>`;
    } else {
      statusHtml = `<span style="color: #94A3B8; font-size: 0.76rem;">Pending</span>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
      <td><strong style="color: #005B9E; font-family: monospace;">${emp.empNo}</strong></td>
      <td><strong>${emp.name}</strong></td>
      <td><span class="skill-level-badge level-${emp.currentLevel || 'I'}" style="font-size: 0.76rem; padding: 2px 8px;">${emp.currentLevel || 'I'} Level</span></td>
      <td>
        <span class="${hasExam ? (examPassed ? 'badge-pass' : 'badge-fail') : ''}" style="font-weight: 700; font-size: 0.8rem;">
          ${examMarkDisplay}
        </span>
      </td>
      <td>
        <span class="${hasOjt ? (ojtPassed ? 'badge-pass' : 'badge-fail') : ''}" style="font-weight: 700; font-size: 0.8rem; cursor: pointer;" onclick="closeSectionCompletedModal(); openOjtModalForEmployee('${emp.empNo}');" title="Click to view/edit OJT">
          ${ojtMarkDisplay}
        </span>
      </td>
      <td>${statusHtml}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 4px; justify-content: center;">
          <button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>
          <button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #DC2626; border-color: #DC2626;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download Official PDF Report">PDF</button>
          <button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #059669; border-color: #059669;" onclick="closeSectionCompletedModal(); openOjtModalForEmployee('${emp.empNo}')">OJT</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPieChart(completed, inProgress, notStarted) {
  const canvas = document.getElementById('completionPieChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (pieChartInstance) {
    try { pieChartInstance.destroy(); } catch (e) {}
  }

  try {
    pieChartInstance = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['Completed', 'In Progress', 'Not Attempted'],
        datasets: [{
          data: [completed, inProgress, notStarted],
          backgroundColor: ['#10B981', '#F59E0B', '#94A3B8']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' }
        }
      }
    });
  } catch (err) {
    console.warn('Pie chart render notice:', err.message);
  }
}

function renderBarChart(records) {
  const canvas = document.getElementById('levelBarChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (barChartInstance) {
    try { barChartInstance.destroy(); } catch (e) {}
  }

  let uCount = 0, lCount = 0, oCount = 0, iCount = 0;

  EMPLOYEES.forEach(emp => {
    const lvl = emp.currentLevel || 'I';
    if (lvl === 'U') uCount++;
    else if (lvl === 'L') lCount++;
    else if (lvl === 'O') oCount++;
    else iCount++;
  });

  try {
    barChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['I Level', 'L Level', 'U Level', 'O Level'],
        datasets: [{
          label: 'Employee Count',
          data: [iCount, lCount, uCount, oCount],
          backgroundColor: ['#3B82F6', '#F59E0B', '#10B981', '#E31B23']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: { beginAtZero: true }
        }
      }
    });
  } catch (err) {
    console.warn('Bar chart render notice:', err.message);
  }
}

// Question Bank Manager View & Manual Mapping Engine
function renderQuestionsManager() {
  const levelFilter = document.getElementById('qLevelFilter').value;
  const sectionFilter = document.getElementById('qSectionFilter') ? document.getElementById('qSectionFilter').value : 'ALL';
  const searchVal = document.getElementById('qSearchInput').value.toLowerCase().trim();
  const container = document.getElementById('questionsListContainer');
  container.innerHTML = '';

  let allQs = [];
  if (levelFilter === 'ALL') {
    allQs = [...(QUESTION_BANK.L || []), ...(QUESTION_BANK.U || []), ...(QUESTION_BANK.O || [])];
  } else {
    allQs = QUESTION_BANK[levelFilter] || [];
  }

  const filtered = allQs.filter(q => {
    let matchSec = true;
    if (sectionFilter !== 'ALL') {
      matchSec = normalizeSectionName(q.section) === normalizeSectionName(sectionFilter);
    }

    let matchSearch = true;
    if (searchVal) {
      matchSearch = q.question.toLowerCase().includes(searchVal) || 
                    (q.category && q.category.toLowerCase().includes(searchVal)) ||
                    (q.section && q.section.toLowerCase().includes(searchVal));
    }

    return matchSec && matchSearch;
  });

  document.getElementById('qCountText').innerText = filtered.length;

  const btnClearFiltered = document.getElementById('btnClearFilteredQs');
  const spanFilteredCount = document.getElementById('btnFilteredCount');
  const hasFilterActive = (levelFilter !== 'ALL' || sectionFilter !== 'ALL' || !!searchVal);
  if (btnClearFiltered) {
    if (hasFilterActive && filtered.length > 0) {
      btnClearFiltered.style.display = 'inline-flex';
      if (spanFilteredCount) spanFilteredCount.innerText = filtered.length;
    } else {
      btnClearFiltered.style.display = 'none';
    }
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <p style="font-size: 1.1rem; margin-bottom: 8px;">No questions found matching your filter.</p>
        <button class="btn-primary" style="max-width: 200px; margin: 0 auto;" onclick="openAddQuestionModal()">➕ Add Question Manually</button>
      </div>
    `;
    return;
  }

  filtered.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'info-item';
    card.style.borderLeft = q.category === 'Safety' ? '4px solid #E31B23' : (q.category === 'CI & TPM' ? '4px solid #F59E0B' : '4px solid #005B9E');
    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
        <div>
          <span class="q-category-tag" style="margin: 0; background: var(--bg-surface); color: var(--text-dark); border: 1px solid var(--border-color);">Level ${q.level}</span>
          <span class="q-category-tag" style="margin: 0 4px;">${q.section || 'General QA'}</span>
          <span class="q-category-tag" style="margin: 0;">${q.category || 'QA & Process'}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 0.78rem; color: var(--text-muted);">ID: ${q.id}</span>
          <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="openEditQuestionModal('${q.id}')">✏️ Edit</button>
          <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; color: var(--accent-red); border-color: #FECDD3;" onclick="deleteQuestion('${q.id}')">🗑️ Delete</button>
        </div>
      </div>
      <div style="font-weight: 700; font-size: 0.95rem; margin-bottom: 10px; line-height: 1.5;">${idx + 1}. ${q.question}</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
        ${q.options.map(opt => `
          <div style="background: ${opt.key === q.correctAnswer ? '#DCFCE7' : '#F8FAFC'}; border: 1px solid ${opt.key === q.correctAnswer ? '#86EFAC' : '#E2E8F0'}; padding: 6px 12px; border-radius: 6px; font-size: 0.82rem;">
            <strong>${opt.key}:</strong> ${opt.text} ${opt.key === q.correctAnswer ? '✔ (Correct)' : ''}
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(card);
  });
}

function openAddQuestionModal() {
  document.getElementById('modalQTitle').innerText = '➕ Add New Question';
  document.getElementById('qEditId').value = '';
  document.getElementById('modalQText').value = '';
  document.getElementById('modalOptA').value = '';
  document.getElementById('modalOptB').value = '';
  document.getElementById('modalOptC').value = '';
  document.getElementById('modalOptD').value = '';
  document.getElementById('modalQCorrect').value = 'A';
  const modal = document.getElementById('modalAddEditQuestion');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function openEditQuestionModal(qId) {
  let targetQ = null;
  ['L', 'U', 'O'].forEach(lvl => {
    const found = (QUESTION_BANK[lvl] || []).find(q => String(q.id).trim() === String(qId).trim());
    if (found) targetQ = found;
  });

  if (!targetQ) return showToast('Question not found: ' + qId);

  document.getElementById('modalQTitle').innerText = '✏️ Edit Question';
  document.getElementById('qEditId').value = targetQ.id;
  document.getElementById('modalQLevel').value = targetQ.level || 'O';
  document.getElementById('modalQSection').value = targetQ.section || 'Final Finish QA';
  document.getElementById('modalQCategory').value = targetQ.category || 'QA & Process';
  document.getElementById('modalQText').value = targetQ.question || '';

  const opts = targetQ.options || [];
  document.getElementById('modalOptA').value = opts[0] ? opts[0].text : '';
  document.getElementById('modalOptB').value = opts[1] ? opts[1].text : '';
  document.getElementById('modalOptC').value = opts[2] ? opts[2].text : '';
  document.getElementById('modalOptD').value = opts[3] ? opts[3].text : '';
  document.getElementById('modalQCorrect').value = targetQ.correctAnswer || 'A';

  const modal = document.getElementById('modalAddEditQuestion');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeQModal() {
  const modal = document.getElementById('modalAddEditQuestion');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function saveQuestionFromModal(e) {
  e.preventDefault();
  const qId = document.getElementById('qEditId').value.trim();
  const level = document.getElementById('modalQLevel').value;
  const section = document.getElementById('modalQSection').value;
  const category = document.getElementById('modalQCategory').value;
  const qText = document.getElementById('modalQText').value.trim();

  const optA = document.getElementById('modalOptA').value.trim();
  const optB = document.getElementById('modalOptB').value.trim();
  const optC = document.getElementById('modalOptC').value.trim();
  const optD = document.getElementById('modalOptD').value.trim();
  const correctAnswer = document.getElementById('modalQCorrect').value;

  if (!qText) {
    alert('Please enter question text');
    return;
  }
  if (!optA || !optB) {
    alert('Please provide at least Option A and Option B');
    return;
  }

  const newQ = {
    id: qId || `${level}_${section.replace(/\s+/g, '_')}_${Date.now()}`,
    level: level,
    section: section,
    category: category,
    question: qText,
    options: [
      { key: 'A', text: optA },
      { key: 'B', text: optB },
      { key: 'C', text: optC },
      { key: 'D', text: optD }
    ],
    correctAnswer: correctAnswer
  };

  if (!QUESTION_BANK[level]) QUESTION_BANK[level] = [];

  if (qId) {
    // Edit existing - remove from any previous level bucket in case level was modified
    ['L', 'U', 'O'].forEach(lvl => {
      const idx = (QUESTION_BANK[lvl] || []).findIndex(q => String(q.id).trim() === String(qId).trim());
      if (idx !== -1) QUESTION_BANK[lvl].splice(idx, 1);
    });
    QUESTION_BANK[level].push(newQ);
    showToast('Question updated successfully!');
  } else {
    // Add new
    QUESTION_BANK[level].push(newQ);
    showToast('New question added successfully!');
  }

  saveCustomQuestionsToServer();
  closeQModal();
  renderQuestionsManager();
}

function deleteQuestion(qId) {
  if (!confirm('Are you sure you want to delete this question?')) return;

  let deleted = false;
  ['L', 'U', 'O'].forEach(lvl => {
    const idx = (QUESTION_BANK[lvl] || []).findIndex(q => String(q.id).trim() === String(qId).trim());
    if (idx !== -1) {
      QUESTION_BANK[lvl].splice(idx, 1);
      deleted = true;
    }
  });

  if (deleted) {
    saveCustomQuestionsToServer();
    showToast('Question deleted successfully');
    renderQuestionsManager();
  } else {
    showToast('Question not found or already removed');
  }
}

// Cloud Sync for Employees & Security Settings
async function syncCloudEmployees() {
  try {
    const res = await fetchWithTimeout('/api/employees', {}, 3500);
    const data = await res.json();
    if (data.success && data.employees && Array.isArray(data.employees) && data.employees.length > 0) {
      EMPLOYEES.length = 0;
      EMPLOYEES.push(...data.employees);
      try {
        localStorage.setItem(STORAGE_KEY_CUSTOM_EMPLOYEES, JSON.stringify(EMPLOYEES));
      } catch (e) {}
      if (document.getElementById('empDirectoryTbody')) {
        renderEmployeeDirectory();
      }
      populateOjtEmployeeSwitcher();
    }
  } catch (e) {}
}

function saveCustomEmployeesToServer() {
  try {
    localStorage.setItem(STORAGE_KEY_CUSTOM_EMPLOYEES, JSON.stringify(EMPLOYEES));
  } catch (e) {}
  try {
    fetchWithTimeout('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employees: EMPLOYEES })
    }, 5000).catch(err => console.log('Employees sync pending:', err.message));
  } catch (e) {}
}

async function syncCloudSettings() {
  try {
    const res = await fetchWithTimeout('/api/settings', {}, 3000);
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      if (s.adminEmail) {
        const el = document.getElementById('secAdminEmail');
        if (el) el.value = s.adminEmail;
      }
      if (s.passingPct) {
        const el = document.getElementById('secPassingPct');
        if (el) el.value = s.passingPct;
      }
      if (s.maxTabSwitches) {
        const el = document.getElementById('secMaxTabSwitches');
        if (el) el.value = s.maxTabSwitches;
      }
      if (s.tabAction) {
        const el = document.getElementById('secTabAction');
        if (el) el.value = s.tabAction;
      }
      if (s.otpDuration) {
        const el = document.getElementById('secOtpDuration');
        if (el) el.value = s.otpDuration;
      }
    }
  } catch (e) {}
}

function saveSecuritySettings(e) {
  if (e) e.preventDefault();
  const settings = {
    adminEmail: document.getElementById('secAdminEmail').value.trim(),
    passingPct: parseInt(document.getElementById('secPassingPct').value) || 70,
    maxTabSwitches: parseInt(document.getElementById('secMaxTabSwitches').value) || 3,
    tabAction: document.getElementById('secTabAction').value,
    otpDuration: parseInt(document.getElementById('secOtpDuration').value) || 60
  };

  try {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings })
    }).then(res => res.json()).then(data => {
 showToast('Security Settings saved & updated in Cloud DB!');
 }).catch(err => showToast('Failed to save settings: ' + err.message));
  } catch (err) {
 showToast('Failed to save settings: ' + err.message);
  }
}

// Employee Directory View
function renderEmployeeDirectory() {
  const searchInput = document.getElementById('empDirectorySearch');
  const search = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const tbody = document.getElementById('empDirectoryTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const filtered = EMPLOYEES.filter(emp => {
    if (!search) return true;
    return emp.empNo.toLowerCase().includes(search) || emp.name.toLowerCase().includes(search) || emp.dept.toLowerCase().includes(search);
  });

  const countEl = document.getElementById('empDirCountText');
 if (countEl) countEl.innerText = filtered.length;

  filtered.forEach(emp => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${emp.empNo}</strong></td>
      <td>${emp.name}</td>
      <td>${emp.dept}</td>
      <td>${emp.section || '-'}</td>
      <td>${emp.doj || '-'}</td>
      <td><span style="background: #E0F2FE; color: #0369A1; font-weight: 700; padding: 2px 8px; border-radius: 4px;">${emp.currentLevel || 'I'}</span></td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn-reset" style="padding: 3px 8px; font-size: 0.76rem; background: #F1F5F9; color: #005B9E; border-color: #CBD5E1;" onclick="openEditEmpModal('${emp.empNo}')">✏️ Edit</button>
          <button class="btn-reset" style="padding: 3px 8px; font-size: 0.76rem; color: #E31B23; border-color: #FECDD3; background: #FFF1F2;" onclick="deleteEmployee('${emp.empNo}')">🗑️ Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openAddEmpModal() {
  document.getElementById('modalEmpTitle').innerText = '➕ Add New Employee';
  document.getElementById('empIsEdit').value = 'false';
  document.getElementById('empOldNo').value = '';
  document.getElementById('modalEmpNo').value = '';
  document.getElementById('modalEmpNo').disabled = false;
  document.getElementById('modalEmpName').value = '';
  document.getElementById('modalEmpDept').value = 'Quality Control';
  document.getElementById('modalEmpSection').value = 'Final Finish QA';
  document.getElementById('modalEmpDoj').value = new Date().toLocaleDateString('en-GB');
  document.getElementById('modalEmpLevel').value = 'I';
  const modal = document.getElementById('modalAddEditEmployee');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function openEditEmpModal(empNo) {
  const emp = EMPLOYEES.find(e => String(e.empNo).trim() === String(empNo).trim());
  if (!emp) return showToast('Employee not found: ' + empNo);
  document.getElementById('modalEmpTitle').innerText = `✏️ Edit Employee (${emp.empNo})`;
  document.getElementById('empIsEdit').value = 'true';
  document.getElementById('empOldNo').value = emp.empNo;
  document.getElementById('modalEmpNo').value = emp.empNo;
  document.getElementById('modalEmpNo').disabled = true;
  document.getElementById('modalEmpName').value = emp.name;
  document.getElementById('modalEmpDept').value = emp.dept || 'Quality Control';
  document.getElementById('modalEmpSection').value = emp.section || 'Final Finish QA';
  document.getElementById('modalEmpDoj').value = emp.doj || '';
  document.getElementById('modalEmpLevel').value = emp.currentLevel || 'I';
  const modal = document.getElementById('modalAddEditEmployee');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeEmpModal() {
  const modal = document.getElementById('modalAddEditEmployee');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function saveEmployeeFromModal(e) {
  e.preventDefault();
  const isEdit = document.getElementById('empIsEdit').value === 'true';
  const oldNo = document.getElementById('empOldNo').value.trim();
  const empNo = document.getElementById('modalEmpNo').value.trim();
  const name = document.getElementById('modalEmpName').value.trim();
  const dept = document.getElementById('modalEmpDept').value.trim();
  const section = document.getElementById('modalEmpSection').value;
  const doj = document.getElementById('modalEmpDoj').value.trim();
  const level = document.getElementById('modalEmpLevel').value;

  if (!empNo || !name) {
    alert('Please enter both Employee ID and Name.');
    return;
  }

  if (!isEdit && EMPLOYEES.some(e => String(e.empNo).trim() === empNo)) {
    alert(`Employee ID '${empNo}' already exists in the directory! Please use a unique Employee ID.`);
    return;
  }

  if (isEdit) {
    const idx = EMPLOYEES.findIndex(e => String(e.empNo).trim() === oldNo);
    if (idx !== -1) {
      EMPLOYEES[idx] = { empNo, name, dept, section, doj, currentLevel: level };
      showToast(`Employee ${empNo} updated successfully!`);
    } else {
      EMPLOYEES.unshift({ empNo, name, dept, section, doj, currentLevel: level });
      showToast(`Employee ${empNo} saved!`);
    }
  } else {
    EMPLOYEES.unshift({ empNo, name, dept, section, doj, currentLevel: level });
    showToast(`New Employee ${empNo} (${name}) added!`);
  }

  saveCustomEmployeesToServer();
  closeEmpModal();
  renderEmployeeDirectory();
  if (document.getElementById('adminTableBody')) {
    const searchInput = document.getElementById('adminSearchInput');
    renderAdminTable(searchInput ? searchInput.value : '');
  }
  populateOjtEmployeeSwitcher();
}

function deleteEmployee(empNo) {
  if (!confirm(`Are you sure you want to delete Employee ${empNo} from the directory?`)) return;
  const idx = EMPLOYEES.findIndex(e => String(e.empNo).trim() === String(empNo).trim());
  if (idx !== -1) {
    EMPLOYEES.splice(idx, 1);
    saveCustomEmployeesToServer();
    showToast(`Employee ${empNo} deleted from Directory`);
    renderEmployeeDirectory();
    if (document.getElementById('adminTableBody')) {
      const searchInput = document.getElementById('adminSearchInput');
      renderAdminTable(searchInput ? searchInput.value : '');
    }
    populateOjtEmployeeSwitcher();
  }
}

// Results Database Table & Reset Action
function renderAdminTable(query) {
  const records = getStoredRecords();
  const allOjt = getStoredOjtRecords();
  const tbody = document.getElementById('adminTableBody');
  tbody.innerHTML = '';

  const q = query.toLowerCase().trim();

  const filtered = EMPLOYEES.filter(emp => {
    if (!q) return true;
    return (
      emp.empNo.toLowerCase().includes(q) ||
      emp.name.toLowerCase().includes(q) ||
      emp.dept.toLowerCase().includes(q) ||
      (emp.section && emp.section.toLowerCase().includes(q))
    );
  });

 document.getElementById('tableCountText').innerText = filtered.length;

  filtered.forEach(emp => {
    const rec = records[emp.empNo] || {};
    const ojt = allOjt[emp.empNo] || {};

    const tr = document.createElement('tr');

    const statusBadge = rec.isCompleted
      ? `<span class="${rec.status && rec.status.includes('Terminated') ? 'badge-fail' : 'badge-pass'}">${rec.status || 'Completed'}</span>`
      : rec.inProgress
      ? `<span class="badge-pending">In Progress (${rec.tabSwitchCount || 0} Sw)</span>`
      : `<span style="color: #94A3B8;">Not Started</span>`;

    const hasOjt = ojt.totalScore !== undefined || ojt.scorePct !== undefined;
    const isOjtQualified = ojt.qualificationStatus === 'Qualified' || (ojt.totalScore !== undefined && ojt.totalScore >= 35);
    const ojtBadge = hasOjt
      ? `<span class="${isOjtQualified ? 'badge-pass' : 'badge-fail'}" style="cursor: pointer; display: inline-block; font-size: 0.78rem;" onclick="openOjtModalForEmployee('${emp.empNo}')" title="Total Score: ${ojt.totalScore || 0}/${ojt.maxScore || 50} Marks - Click to open">${ojt.qualificationStatus || (isOjtQualified ? 'Qualified' : 'Not Qualified')} (${ojt.totalScore || 0}/${ojt.maxScore || 50} Marks)</span>`
      : `<span style="color: #94A3B8; font-size: 0.8rem; cursor: pointer; text-decoration: underline dotted;" onclick="openOjtModalForEmployee('${emp.empNo}')" title="Click to open OJT evaluation">Pending</span>`;

    const hasRecord = rec.isCompleted || rec.inProgress;
    const actionBtn = `
      <div style="display: flex; gap: 5px; flex-wrap: wrap;">
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #DC2626; border-color: #DC2626;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download Official PDF Report">PDF</button>
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #059669; border-color: #059669;" onclick="openOjtModalForEmployee('${emp.empNo}')">OJT Form</button>
        ${hasRecord ? `<button class="btn-reset" style="padding: 3px 8px; font-size: 0.75rem;" onclick="confirmAndResetExam('${emp.empNo}', '${emp.name.replace(/'/g, "\\'")}')">Reset</button>` : ''}
      </div>
    `;

    tr.innerHTML = `
      <td><strong>${emp.empNo}</strong></td>
      <td>${emp.name}</td>
      <td>${emp.doj || '-'}</td>
      <td>${emp.dept}</td>
      <td>${emp.section || '-'}</td>
      <td>${emp.currentLevel || 'I'}</td>
      <td>${rec.uMark !== undefined ? rec.uMark : '-'}</td>
      <td>${rec.lMark !== undefined ? rec.lMark : '-'}</td>
      <td>${rec.oMark !== undefined ? rec.oMark : '-'}</td>
      <td><strong>${rec.totalMark !== undefined ? rec.totalMark : '-'}</strong></td>
      <td>${rec.totalMark !== undefined ? (rec.totalMark >= 21 ? 'Pass (≥21)' : 'Retest (<21)') : '-'}</td>
      <td>${statusBadge}</td>
      <td>${ojtBadge}</td>
      <td>${rec.attemptDate || '-'}</td>
      <td>${actionBtn}</td>
    `;

    tbody.appendChild(tr);
  });
}

// Download Official PDF Evaluation Report for Employee Assessment (Word Vector PDF)
async function downloadEmployeePDF(empNo) {
  if (!empNo) return alert('Employee ID is required.');
  showToast(`Generating official PDF report for Employee ${empNo}...`);

  try {
    const records = getStoredRecords();
    const recordData = records[empNo] || null;

    let res = null;
    try {
      res = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empNo: String(empNo), recordData })
      });

      if (!res.ok) {
        res = await fetch(`/api/generate-pdf/${encodeURIComponent(empNo)}`);
      }
    } catch (netErr) {
      console.warn('Server dynamic PDF generation error:', netErr.message);
    }

    if (res && res.ok) {
      const contentType = res.headers.get('Content-Type') || '';
      if (contentType.includes('application/pdf') || res.url.endsWith('.pdf')) {
        const blob = await res.blob();
        const contentDisp = res.headers.get('Content-Disposition') || '';
        let filename = `Yokohama_ILUO_Report_${empNo}.pdf`;
        const fnMatch = contentDisp.match(/filename="?([^"]+)"?/);
        if (fnMatch && fnMatch[1]) {
          filename = fnMatch[1];
        }

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast(`Official PDF report for Employee ${empNo} downloaded successfully!`);
        return;
      }
    }

    // Direct fallback: Download the official DOCX report so the user has the 100% accurate file
    showToast(`Downloading official Word Document (.docx) report for Employee ${empNo}...`);
    await downloadEmployeeDocx(empNo);

  } catch (err) {
    console.error('PDF Download error:', err);
    await downloadEmployeeDocx(empNo);
  }
}
window.downloadEmployeePDFReport = downloadEmployeePDF;

// Download Official DOCX Evaluation Report for Employee Assessment (Universal Client + Server)
async function downloadEmployeeDocx(empNo) {
  if (!empNo) return alert('Employee ID is required.');
  showToast(`Generating official Word Document (.docx) report for Employee ${empNo}...`);

  try {
    const records = getStoredRecords();
    const recordData = records[empNo] || null;

    let res = null;
    try {
      res = await fetch('/api/generate-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empNo: String(empNo), recordData })
      });

      if (!res.ok) {
        // Fallback to GET endpoint
        res = await fetch(`/api/employee-docx/${encodeURIComponent(empNo)}`);
      }
    } catch (netErr) {
      console.warn('Server DOCX generation unreachable, using client-side fallback:', netErr.message);
      res = null;
    }

    if (res && res.ok) {
      const blob = await res.blob();
      const contentDisp = res.headers.get('Content-Disposition') || '';
      let filename = `Yokohama_ILUO_Report_${empNo}.docx`;
      const fnMatch = contentDisp.match(/filename="?([^"]+)"?/);
      if (fnMatch && fnMatch[1]) {
        filename = fnMatch[1];
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showToast(`Official DOCX report for Employee ${empNo} downloaded successfully!`);
      return;
    }

    // Client-Side Generation Fallback (runs in browser when on Vercel / serverless / offline)
    console.log('Generating DOCX on client-side for Employee', empNo);
    await generateClientSideDocx(empNo, recordData);

  } catch (err) {
    console.error('DOCX Download error:', err);
    try {
      const records = getStoredRecords();
      await generateClientSideDocx(empNo, records[empNo] || null);
    } catch (clientErr) {
      console.error('Client-side DOCX fallback error:', clientErr);
      showToast(`Could not generate DOCX: ${clientErr.message}`);
    }
  }
}
window.downloadEmployeeDocxReport = downloadEmployeeDocx;

// Helper: Build exact Word (.docx) binary package in browser
async function buildClientSideDocxBlob(empNo, recordData) {
  if (typeof window.YokohamaDocxGenerator === 'undefined' || typeof window.JSZip === 'undefined') {
    throw new Error('DOCX generator library is loading. Please try again in a moment.');
  }

  const allEmps = (typeof EMPLOYEES !== 'undefined') ? EMPLOYEES : [];
  const emp = allEmps.find(e => String(e.empNo).trim() === String(empNo).trim()) || {
    empNo: empNo,
    name: `Employee ${empNo}`,
    dept: 'QUALITY CONTROL',
    section: 'Tire building QA',
    doj: '-',
    targetLevel: 'O'
  };

  const examRecord = recordData || (getStoredRecords()[empNo] || null);
  const targetLevel = (examRecord && examRecord.targetLevel) || emp.targetLevel || emp.currentLevel || 'O';
  const templateFilename = window.YokohamaDocxGenerator.getTemplateFilename(targetLevel, emp.section);

  let templateArrayBuffer = null;
  const possiblePaths = [
    `QC_templates/${encodeURIComponent(templateFilename)}`,
    `QC_templates/${templateFilename}`,
    `/QC_templates/${encodeURIComponent(templateFilename)}`,
    `/QC_templates/${templateFilename}`,
    `QC question/${encodeURIComponent(templateFilename)}`,
    `QC question/${templateFilename}`,
    `./QC_templates/${encodeURIComponent(templateFilename)}`,
    `./QC_templates/${templateFilename}`
  ];

  for (const path of possiblePaths) {
    try {
      const resp = await fetch(path);
      if (resp.ok) {
        templateArrayBuffer = await resp.arrayBuffer();
        break;
      }
    } catch (e) {}
  }

  if (!templateArrayBuffer) {
    throw new Error(`Could not load template file: ${templateFilename}`);
  }

  const qbQuestions = (typeof QUESTION_BANK !== 'undefined' && QUESTION_BANK[targetLevel]) ? QUESTION_BANK[targetLevel] : [];
  const allOjt = (typeof getStoredOjtRecords === 'function') ? getStoredOjtRecords() : {};
  const ojtRec = allOjt[empNo] || null;
  const ojtTmpl = (typeof getOjtTemplateForSection === 'function') ? getOjtTemplateForSection(emp.section) : null;

  const zip = await window.YokohamaDocxGenerator.mapExactTemplate(
    templateArrayBuffer,
    emp,
    examRecord,
    window.JSZip,
    qbQuestions,
    ojtRec,
    ojtTmpl
  );

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const safeName = (emp.name || empNo).replace(/[\s\\/]+/g, '_');
  const filename = `Yokohama_ILUO_Report_${empNo}_${safeName}.docx`;

  return { blob, emp, filename };
}

async function generateClientSideDocx(empNo, recordData) {
  const { blob, filename } = await buildClientSideDocxBlob(empNo, recordData);
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
  showToast(`Official DOCX report for Employee ${empNo} downloaded successfully!`);
}

async function generateClientSidePdf(empNo, recordData) {
  const { blob, emp, filename } = await buildClientSideDocxBlob(empNo, recordData);

  // 1. Attempt server-side DOCX-to-PDF conversion endpoint
  try {
    const convertRes = await fetch('/api/convert-docx-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      body: blob
    });
    if (convertRes.ok) {
      const pdfBlob = await convertRes.blob();
      const pdfUrl = window.URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = pdfUrl;
      const safeName = (emp.name || empNo).replace(/[\s\\/]+/g, '_');
      a.download = `Yokohama_ILUO_Report_${empNo}_${safeName}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(pdfUrl);
      document.body.removeChild(a);
      showToast(`Official PDF report for Employee ${empNo} downloaded successfully!`);
      return;
    }
  } catch (convErr) {
    console.warn('Server docx-to-pdf converter unreachable, rendering via docx-preview print:', convErr.message);
  }

  // 2. High-fidelity in-browser Print to PDF using docx-preview
  if (typeof window.docx !== 'undefined' && typeof window.docx.renderAsync === 'function') {
    showToast('Rendering exact Word layout for Print to PDF...');
    let iframe = document.getElementById('docxPrintFrame');
    if (iframe) {
      try { iframe.remove(); } catch(e) {}
    }
    iframe = document.createElement('iframe');
    iframe.id = 'docxPrintFrame';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0.01';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Yokohama ILUO Assessment Report - ${empNo}</title>
        <meta charset="utf-8">
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          html, body { margin: 0; padding: 0; background: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
          .docx-wrapper { background: #ffffff !important; padding: 0 !important; }
          .docx { box-shadow: none !important; margin: 0 auto !important; padding: 0 !important; width: 100% !important; }
          table { border-collapse: collapse !important; width: 100% !important; }
          td, th { padding: 4px 6px !important; }
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <div id="docxPrintContent"></div>
      </body>
      </html>
    `);
    doc.close();

    const targetDiv = doc.getElementById('docxPrintContent');
    const arrayBuffer = await blob.arrayBuffer();
    await window.docx.renderAsync(arrayBuffer, targetDiv, null, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      ignoreHeight: false,
      ignoreWidth: false
    });

    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        showToast(`Print dialog opened. Select "Save as PDF" to save exact report.`);
      } catch(printErr) {
        console.error('Print window error:', printErr);
      }
      setTimeout(() => {
        try { iframe.remove(); } catch(e) {}
      }, 30000);
    }, 700);

    return;
  }

  // 3. Fallback: Download DOCX so employee or supervisor can save as PDF in Word
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
  showToast(`Downloaded DOCX report for Employee ${empNo}. (Open in MS Word to Save As PDF)`);
}

function confirmAndResetExam(empNo, empName) {
  if (confirm(`Are you sure you want to RESET the assessment for Employee ${empNo} (${empName})?\n\nThis will clear all previous answers, marks, tab switch warnings, and status so they can take the test again.`)) {
    const records = getStoredRecords();
    if (records[empNo]) {
      delete records[empNo];
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));
      try {
        fetch('/api/records/' + encodeURIComponent(empNo), { method: 'DELETE' }).catch(e => {});
      } catch (e) {}
 showToast(`Exam reset successfully for Employee ${empNo}`);
      renderAdminTable('');
    }
  }
}

function filterAdminTable() {
  const val = document.getElementById('adminSearchInput').value;
  renderAdminTable(val);
}

// ---------------------------------------------------------------------
// REPORTS & EXCEL OPERATIONS CENTER
// ---------------------------------------------------------------------
function renderReportsCenter() {
  const records = getStoredRecords();
  const allEmps = EMPLOYEES;

  // Populate Employee Select Dropdown
  const empSelect = document.getElementById('reportEmpSelect');
  if (empSelect) {
    const currentVal = empSelect.value;
    empSelect.innerHTML = '<option value="">-- Choose Employee --</option>' + allEmps.map(emp => {
      const rec = records[emp.empNo];
      const statusBadge = rec && rec.isCompleted ? ` [${rec.status || 'Done'} - ${rec.markPct || 0}%]` : '';
      return `<option value="${emp.empNo}">[${emp.empNo}] ${emp.name} - ${emp.section}${statusBadge}</option>`;
    }).join('');
    if (currentVal) empSelect.value = currentVal;
  }
}

function exportDataToCSV(dataArray, filename) {
  if (!dataArray || !dataArray.length) {
 showToast('No records available for export.');
    return;
  }
  const headers = Object.keys(dataArray[0]);
  const rows = [];
  rows.push(headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','));

  dataArray.forEach(row => {
    const vals = headers.map(h => {
      const val = row[h] === undefined || row[h] === null ? '' : String(row[h]);
      return `"${val.replace(/"/g, '""')}"`;
    });
    rows.push(vals.join(','));
  });

  const csvContent = '\uFEFF' + rows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getAdminExportDataset() {
  const records = getStoredRecords();
  const allOjt = getStoredOjtRecords();
  return EMPLOYEES.map((emp, index) => {
    const rec = records[emp.empNo] || {};
    const ojt = allOjt[emp.empNo] || {};
    const hasOjt = ojt.totalScore !== undefined || ojt.scorePct !== undefined;
    const examStatus = rec.status || (rec.inProgress ? "In Progress" : "Not Started");
    const ojtStatus = hasOjt ? (ojt.qualificationStatus || (ojt.scorePct >= 70 ? "Qualified" : "Not Qualified")) : "Pending";

    let overallStatus = "Pending";
    if (rec.isCompleted && hasOjt) {
      if (rec.status === "Passed" && (ojtStatus === "Qualified" || ojt.scorePct >= 70)) {
        overallStatus = "Fully Qualified";
      } else {
        overallStatus = "Needs Retest / Improvement";
      }
    } else if (rec.isCompleted) {
      overallStatus = rec.status === "Passed" ? "Exam Passed (OJT Pending)" : "Exam Failed";
    }

    return {
      "S.No": index + 1,
      "Employee No": emp.empNo,
      "Name": emp.name,
      "DOJ": emp.doj || "",
      "Department": emp.dept,
      "Section": emp.section || "",
      "Skill Level": emp.currentLevel || "I",
      "U mark": rec.uMark !== undefined ? rec.uMark : 0,
      "L mark": rec.lMark !== undefined ? rec.lMark : 0,
      "O mark": rec.oMark !== undefined ? rec.oMark : 0,
      "Total Mark": rec.totalMark !== undefined ? rec.totalMark : 0,
      "Exam Percentage": rec.markPct !== undefined ? rec.markPct + "%" : "0%",
      "Tab Switches": rec.tabSwitchCount || 0,
      "Exam Status": examStatus,
      "OJT Score": hasOjt ? `${ojt.totalScore}/${ojt.maxScore || 50}` : "-",
      "OJT Percentage": hasOjt ? `${ojt.scorePct}%` : "-",
      "OJT Status": ojtStatus,
      "Overall Status": overallStatus,
      "Attempt Date": rec.attemptDate || ""
    };
  });
}

// Export Excel Report for Admin Only
function exportAdminExcel() {
  try {
    const exportData = getAdminExportDataset();
    const filename = `Yokohama_ILUO_QA_Assessment_Report_${new Date().toISOString().split('T')[0]}`;

    if (typeof XLSX !== 'undefined') {
      const worksheet = XLSX.utils.json_to_sheet(exportData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "ILUO Assessment Report");
      XLSX.writeFile(workbook, `${filename}.xlsx`);
 showToast('Master Excel report (.xlsx) downloaded successfully!');
    } else {
      exportDataToCSV(exportData, `${filename}.csv`);
 showToast('Downloaded as CSV report (Excel compatible).');
    }
  } catch (err) {
    console.error('Export Excel failed:', err);
    exportAdminCSV();
  }
}

function exportAdminCSV() {
  const exportData = getAdminExportDataset();
  const filename = `Yokohama_ILUO_QA_Assessment_Report_${new Date().toISOString().split('T')[0]}.csv`;
  exportDataToCSV(exportData, filename);
 showToast('Master CSV report downloaded successfully!');
}

function exportSelectedSectionExcel() {
  const selectEl = document.getElementById('reportSectionSelect');
  const secKey = selectEl ? selectEl.value : 'warehouse';
  exportCurrentSectionExcel(secKey);
}

function exportSelectedSectionCSV() {
  const selectEl = document.getElementById('reportSectionSelect');
  const secKey = selectEl ? selectEl.value : 'warehouse';
  exportCurrentSectionCSV(secKey);
}

function exportFullQuestionBankExcel() {
  const allQs = [];
  ['L', 'U', 'O'].forEach(lvl => {
    (QUESTION_BANK[lvl] || []).forEach(q => {
      allQs.push({
        "Level": q.level,
        "Section": q.section,
        "Question ID": q.id,
        "Category": q.category || "General QA",
        "Question Text": q.question,
        "Option A": (q.options && q.options[0]) ? q.options[0].text : "",
        "Option B": (q.options && q.options[1]) ? q.options[1].text : "",
        "Option C": (q.options && q.options[2]) ? q.options[2].text : "",
        "Option D": (q.options && q.options[3]) ? q.options[3].text : "",
        "Correct Answer": q.correctAnswer
      });
    });
  });

  const filename = `Yokohama_QA_Question_Bank_Master_${new Date().toISOString().split('T')[0]}`;
  try {
    if (typeof XLSX !== 'undefined') {
      const workbook = XLSX.utils.book_new();
      ['L', 'U', 'O'].forEach(lvl => {
        const lvlQs = allQs.filter(q => q.Level === lvl);
        const ws = XLSX.utils.json_to_sheet(lvlQs);
        XLSX.utils.book_append_sheet(workbook, ws, `${lvl} Level Questions`);
      });
      XLSX.writeFile(workbook, `${filename}.xlsx`);
 showToast('Master Question Bank Excel downloaded successfully!');
    } else {
      exportDataToCSV(allQs, `${filename}.csv`);
 showToast('Question Bank downloaded as CSV.');
    }
  } catch (err) {
    console.error('Question Bank Excel export error:', err);
    exportDataToCSV(allQs, `${filename}.csv`);
 showToast('Downloaded Question Bank as CSV.');
  }
}

function generateSelectedEmployeePDF() {
  const selectEl = document.getElementById('reportEmpSelect');
  const empNo = selectEl ? selectEl.value : '';
  if (!empNo) {
    showToast('Please select an employee from the dropdown list first.');
    return;
  }
  downloadEmployeePDF(empNo);
}

function generateSelectedEmployeeDocx() {
  const selectEl = document.getElementById('reportEmpSelect');
  const empNo = selectEl ? selectEl.value : '';
  if (!empNo) {
    showToast('Please select an employee from the dropdown list first.');
    return;
  }
  downloadEmployeeDocx(empNo);
}

// ---------------------------------------------------------------------
// SECTION & LEVEL QUESTION CLEARING ENGINE
// ---------------------------------------------------------------------

function openClearQuestionsModal(prefillSection, prefillLevel) {
  const modal = document.getElementById('modalClearQuestions');
  if (!modal) return;

  const secSelect = document.getElementById('clearModalSection');
  const lvlSelect = document.getElementById('clearModalLevel');

  // Pre-fill with passed values or current table filters
  const currentSec = prefillSection || (document.getElementById('qSectionFilter') ? document.getElementById('qSectionFilter').value : 'ALL');
  const currentLvl = prefillLevel || (document.getElementById('qLevelFilter') ? document.getElementById('qLevelFilter').value : 'ALL');

  if (secSelect) secSelect.value = currentSec;
  if (lvlSelect) lvlSelect.value = currentLvl;

  updateClearModalImpact();

  modal.classList.add('active');
  modal.style.display = 'flex';
}

function closeClearQuestionsModal() {
  const modal = document.getElementById('modalClearQuestions');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function getMatchingQuestionsCount(targetSection, targetLevel) {
  const levels = (targetLevel === 'ALL' || !targetLevel) ? ['L', 'U', 'O'] : [targetLevel];
  let count = 0;

  levels.forEach(lvl => {
    const list = QUESTION_BANK[lvl] || [];
    if (targetSection === 'ALL' || !targetSection) {
      count += list.length;
    } else {
      const normTarget = normalizeSectionName(targetSection);
      count += list.filter(q => normalizeSectionName(q.section) === normTarget).length;
    }
  });

  return count;
}

function getTotalQuestionsInBank() {
  return (QUESTION_BANK.L || []).length + (QUESTION_BANK.U || []).length + (QUESTION_BANK.O || []).length;
}

function updateClearModalImpact() {
  const secSelect = document.getElementById('clearModalSection');
  const lvlSelect = document.getElementById('clearModalLevel');
  const targetSection = secSelect ? secSelect.value : 'ALL';
  const targetLevel = lvlSelect ? lvlSelect.value : 'ALL';

  const matchCount = getMatchingQuestionsCount(targetSection, targetLevel);
  const totalCount = getTotalQuestionsInBank();
  const remainCount = totalCount - matchCount;

  const headingEl = document.getElementById('clearImpactHeading');
  const detailsEl = document.getElementById('clearImpactDetails');
  const btnDelete = document.getElementById('btnConfirmClearSelected');
  const impactBox = document.getElementById('clearImpactBox');

  const secLabel = targetSection === 'ALL' ? 'All QC Sections' : targetSection;
  const lvlLabel = targetLevel === 'ALL' ? 'All Levels (L, U, O)' : `Level ${targetLevel}`;

  if (matchCount === 0) {
    if (headingEl) headingEl.innerText = `0 questions match your selection`;
    if (detailsEl) detailsEl.innerText = `There are currently no questions in ${secLabel} (${lvlLabel}). Nothing to delete.`;
    if (btnDelete) {
      btnDelete.disabled = true;
      btnDelete.innerText = '🗑️ No Matching Questions to Delete';
      btnDelete.style.opacity = '0.5';
      btnDelete.style.cursor = 'not-allowed';
    }
    if (impactBox) {
      impactBox.style.background = '#F8FAFC';
      impactBox.style.borderColor = '#CBD5E1';
    }
  } else {
    if (headingEl) headingEl.innerText = `⚠️ ${matchCount} questions will be deleted`;
    if (detailsEl) detailsEl.innerHTML = `Scope: <strong>${secLabel}</strong> &bull; <strong>${lvlLabel}</strong>.<br>Remaining questions in bank after deletion: <strong>${remainCount}</strong> questions.`;
    if (btnDelete) {
      btnDelete.disabled = false;
      btnDelete.innerText = `🗑️ Delete ${matchCount} Questions from ${targetSection === 'ALL' ? 'All Sections' : targetSection} (${targetLevel === 'ALL' ? 'All Levels' : 'Level ' + targetLevel})`;
      btnDelete.style.opacity = '1';
      btnDelete.style.cursor = 'pointer';
    }
    if (impactBox) {
      impactBox.style.background = '#FEF2F2';
      impactBox.style.borderColor = '#FCA5A5';
    }
  }
}

function confirmExecuteClear() {
  const secSelect = document.getElementById('clearModalSection');
  const lvlSelect = document.getElementById('clearModalLevel');
  const targetSection = secSelect ? secSelect.value : 'ALL';
  const targetLevel = lvlSelect ? lvlSelect.value : 'ALL';

  const matchCount = getMatchingQuestionsCount(targetSection, targetLevel);
  if (matchCount === 0) {
    showToast('No matching questions found to delete.');
    return;
  }

  const secLabel = targetSection === 'ALL' ? 'ALL Sections' : targetSection;
  const lvlLabel = targetLevel === 'ALL' ? 'ALL Levels (L, U, O)' : `Level ${targetLevel}`;

  const promptMsg = `⚠️ ARE YOU SURE?\n\nYou are about to DELETE ${matchCount} questions from:\n\nSection: ${secLabel}\nLevel: ${lvlLabel}\n\nThis will remove them permanently from the Question Bank!`;
  if (!confirm(promptMsg)) return;

  deleteQuestionsBySectionAndLevel(targetSection, targetLevel);
  closeClearQuestionsModal();
  showToast(`Successfully deleted ${matchCount} questions from ${secLabel} (${lvlLabel}).`);
}

function deleteQuestionsBySectionAndLevel(targetSection, targetLevel) {
  const levels = (targetLevel === 'ALL' || !targetLevel) ? ['L', 'U', 'O'] : [targetLevel];
  let deletedCount = 0;

  levels.forEach(lvl => {
    if (!QUESTION_BANK[lvl] || !Array.isArray(QUESTION_BANK[lvl])) return;
    const initialLen = QUESTION_BANK[lvl].length;

    if (targetSection === 'ALL' || !targetSection) {
      deletedCount += initialLen;
      QUESTION_BANK[lvl] = [];
    } else {
      const normTarget = normalizeSectionName(targetSection);
      const remaining = QUESTION_BANK[lvl].filter(q => {
        const matches = normalizeSectionName(q.section) === normTarget;
        if (matches) deletedCount++;
        return !matches;
      });
      QUESTION_BANK[lvl] = remaining;
    }
  });

  saveCustomQuestionsToServer();
  renderQuestionsManager();
  return deletedCount;
}

function clearCurrentFilteredQuestions() {
  const secFilter = document.getElementById('qSectionFilter') ? document.getElementById('qSectionFilter').value : 'ALL';
  const lvlFilter = document.getElementById('qLevelFilter') ? document.getElementById('qLevelFilter').value : 'ALL';
  openClearQuestionsModal(secFilter, lvlFilter);
}

function confirmClearAllQuestionsBank() {
  const total = getTotalQuestionsInBank();
  if (total === 0) {
    showToast('Question bank is already empty.');
    return;
  }

  const confirm1 = confirm(`⚠️ WARNING: DANGER ZONE!\n\nAre you sure you want to DELETE ALL ${total} QUESTIONS from the entire bank?\n\nThis will erase questions across ALL sections (L, U, and O levels)!`);
  if (!confirm1) return;

  QUESTION_BANK.L = [];
  QUESTION_BANK.U = [];
  QUESTION_BANK.O = [];

  saveCustomQuestionsToServer();
  closeClearQuestionsModal();
  showToast(`Entire Question Bank cleared! (Deleted ${total} questions)`);
  renderQuestionsManager();
}

function restoreDefaultQuestionsBank() {
  if (typeof DEFAULT_QUESTION_BANK === 'undefined') {
    showToast('Default question bank snapshot not found.');
    return;
  }

  const confirmRestore = confirm('🔄 Restore Default Question Bank?\n\nThis will restore the factory default questions for all sections and levels from the master curriculum.');
  if (!confirmRestore) return;

  QUESTION_BANK.L = JSON.parse(JSON.stringify(DEFAULT_QUESTION_BANK.L || []));
  QUESTION_BANK.U = JSON.parse(JSON.stringify(DEFAULT_QUESTION_BANK.U || []));
  QUESTION_BANK.O = JSON.parse(JSON.stringify(DEFAULT_QUESTION_BANK.O || []));

  saveCustomQuestionsToServer();
  closeClearQuestionsModal();
  showToast('Default Question Bank successfully restored!');
  renderQuestionsManager();
}

// Backward compatibility alias
function clearAllQuestions() {
  openClearQuestionsModal();
}

// ---------------------------------------------------------------------
// QUESTION BANK FILE UPLOADER & PARSER (.docx, .xlsx, .xls, .json)
// ---------------------------------------------------------------------
function parseFilenameInfo(fname) {
  let level = 'O';
  if (/L[\s_-]Level|^L[\s_-]|_L_/i.test(fname)) level = 'L';
  else if (/U[\s_-]Level|^U[\s_-]|_U_/i.test(fname)) level = 'U';
  else if (/O[\s_-]Level|^O[\s_-]|_O_/i.test(fname)) level = 'O';

  let sec = 'Final Finish QA';
  if (/Final Finish RRO|RRO.*ALT/i.test(fname)) sec = 'Final Finish RRO & ALT QA';
  else if (/Final Finish/i.test(fname)) sec = 'Final Finish QA';
  else if (/Tire Building|TBM/i.test(fname)) sec = 'Tire Building QA';
  else if (/Tire Curing/i.test(fname)) sec = 'Tire Curing QA';
  else if (/Solid Tire/i.test(fname)) sec = 'Solid Tire QA';
  else if (/Preparatory/i.test(fname)) sec = 'Preparatory QA';
  else if (/Warehouse/i.test(fname)) sec = 'Warehouse QA';
  else if (/FID Inspector/i.test(fname)) sec = 'FID Inspector QA';

  return { level, sec };
}

function isDocxNoiseLine(txt) {
  const t = (txt || '').trim();
  const skip = [
    'Assessment Questionnaire', 'Marks Classification', 'Parameters',
    'S.No', 'Question Description', '0 –', '1 –', '2 –',
    'NAME', 'EMPLOYEE NO', 'DEPARTMENT', 'DOJ', 'SECTION', 'DATE', 'TOTAL MARKS', 'MARK %',
    'Grand Total', 'Supervisor/Manager'
  ];
  if (skip.some(s => t.startsWith(s) || t === s)) return true;
  if (/^Yes\s*\(/i.test(t)) return true;
  if (/^\d+[\.\)]\s*Yes\s*\(/i.test(t)) return true;
  if (/^[a-b][\.\)]\s*(Yes|No)\b/i.test(t)) return true;
  return false;
}

function isDocxCategoryHeader(txt) {
  const u = (txt || '').trim().toUpperCase();
  return ['SAFETY', 'SAFETY & ENVIRONMENT', 'CI & TPM', 'CI AND TPM', 'TPM', 'PROCESS', 'QUALITY', 'QA & PROCESS', 'QUALITY & PROCESS', 'PROCESS & QUALITY'].includes(u);
}

function getDocxCategory(txt, current) {
  const u = (txt || '').trim().toUpperCase();
  if (u === 'SAFETY' || u.startsWith('SAFETY')) return 'Safety';
  if (u.includes('CI & TPM') || u.includes('CI AND TPM') || u === 'TPM') return 'CI & TPM';
  if (u === 'PROCESS' || u === 'QUALITY' || u.includes('QA & PROCESS') || u.includes('QUALITY & PROCESS') || u.includes('PROCESS & QUALITY')) return 'QA & Process';
  return current || 'Safety';
}

function parseOptsFromText(text) {
  if (!text) return null;
  // Match a. b. c. d. preceded by non-letter, whitespace, or start
  const optRegex = /(?<=[^a-z\s]|\s|^)([a-d])[\.\)]\s*/i;
  if (optRegex.test(text)) {
    const parts = text.split(/(?<=[^a-z\s]|\s|^)([a-d])[\.\)]\s*/i);
    if (parts.length >= 3) {
      const qText = parts[0].trim();
      const opts = [];
      for (let i = 1; i < parts.length; i += 2) {
        if (opts.length < 4) {
          opts.push({
            key: parts[i].toUpperCase(),
            text: (parts[i + 1] || '').trim()
          });
        }
      }
      if (opts.length >= 2) {
        return { qText, opts };
      }
    }
  }

  // Also check for 1. 2. 3. 4.
  const numRegex = /(?<=[^\d\s]|\s|^)([1-4])[\.\)]\s*/;
  if (numRegex.test(text)) {
    const parts = text.split(/(?<=[^\d\s]|\s|^)([1-4])[\.\)]\s*/);
    if (parts.length >= 3) {
      const qText = parts[0].trim();
      const keys = ['A', 'B', 'C', 'D'];
      const opts = [];
      for (let i = 1; i < parts.length; i += 2) {
        if (opts.length < 4) {
          opts.push({
            key: keys[opts.length],
            text: (parts[i + 1] || '').trim()
          });
        }
      }
      if (opts.length >= 2) {
        return { qText, opts };
      }
    }
  }

  return null;
}

function parseDocxText(rawText, filename) {
  const { level, sec } = parseFilenameInfo(filename);
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let currentCat = 'Safety';
  const questions = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Stop at supervisor skill parameter checklist
    if (line.includes('Parameters – Skill') || line.includes('Parameters - Skill') || line.includes('Marks Classification for Skill parameters')) {
      break;
    }

    if (isDocxCategoryHeader(line)) {
      currentCat = getDocxCategory(line, currentCat);
      i++;
      continue;
    }

    if (isDocxNoiseLine(line)) {
      i++;
      continue;
    }

    // CASE 1: Line itself contains question + embedded options (qText is non-empty)
    const embedded = parseOptsFromText(line);
    if (embedded && embedded.qText.length > 3 && embedded.opts.length >= 2) {
      const cleanQ = embedded.qText.replace(/^\d+[\.\)]\s*/, '').trim();
      questions.push({
        id: `${level}_${sec.replace(/\s+/g, '_')}_${questions.length + 1}`,
        level: level,
        section: sec,
        category: currentCat,
        question: cleanQ,
        options: embedded.opts,
        correctAnswer: 'A'
      });
      i++;
      continue;
    }

    // CASE 2: Line is question, and next line contains all options together
    if (i + 1 < lines.length) {
      const nextL = lines[i + 1];
      const embeddedNext = parseOptsFromText(nextL);
      if (embeddedNext && embeddedNext.opts.length >= 2) {
        const cleanQ = (embeddedNext.qText ? (line + ' ' + embeddedNext.qText) : line).replace(/^\d+[\.\)]\s*/, '').trim();
        let finalOpts = [...embeddedNext.opts];

        // Check if line i+2 has more options (e.g. c and d)
        if (finalOpts.length === 2 && i + 2 < lines.length) {
          const nextNextL = lines[i + 2];
          const embeddedNextNext = parseOptsFromText(nextNextL);
          if (embeddedNextNext && embeddedNextNext.opts.length >= 2) {
            finalOpts.push(...embeddedNextNext.opts);
            questions.push({
              id: `${level}_${sec.replace(/\s+/g, '_')}_${questions.length + 1}`,
              level: level,
              section: sec,
              category: currentCat,
              question: cleanQ,
              options: finalOpts,
              correctAnswer: 'A'
            });
            i += 3;
            continue;
          }
        }

        questions.push({
          id: `${level}_${sec.replace(/\s+/g, '_')}_${questions.length + 1}`,
          level: level,
          section: sec,
          category: currentCat,
          question: cleanQ,
          options: finalOpts,
          correctAnswer: 'A'
        });
        i += 2;
        continue;
      }
    }

    // CASE 3: Line is question, followed by 4 separate option lines
    const candidateOpts = [];
    let j = i + 1;
    while (j < lines.length && candidateOpts.length < 4) {
      const nextL = lines[j];
      if (nextL.includes('Parameters – Skill') || nextL.includes('Parameters - Skill')) break;
      if (isDocxCategoryHeader(nextL) || isDocxNoiseLine(nextL)) break;
      if (candidateOpts.length >= 2 && (nextL.includes('?') || /^\d+[\.\)]\s+[A-Za-z]/i.test(nextL))) break;
      candidateOpts.push(nextL);
      j++;
    }

    if (candidateOpts.length === 4) {
      const keys = ['A', 'B', 'C', 'D'];
      const opts = candidateOpts.map((opt, idx) => ({
        key: keys[idx],
        text: opt.replace(/^[a-d1-4][\.\)]\s*/i, '').trim()
      }));

      const cleanQ = line.replace(/^\d+[\.\)]\s*/, '').trim();

      questions.push({
        id: `${level}_${sec.replace(/\s+/g, '_')}_${questions.length + 1}`,
        level: level,
        section: sec,
        category: currentCat,
        question: cleanQ,
        options: opts,
        correctAnswer: 'A'
      });
      i = j;
      continue;
    }

    i++;
  }

  return questions;
}

function parseExcelQuestions(workbook, filename) {
  const { level: fileLevel, sec: fileSec } = parseFilenameInfo(filename);
  const questions = [];

  workbook.SheetNames.forEach(sheetName => {
    let sheetLevel = fileLevel;
    if (/L[\s_-]Level|^L[\s_-]|_L_/i.test(sheetName)) sheetLevel = 'L';
    else if (/U[\s_-]Level|^U[\s_-]|_U_/i.test(sheetName)) sheetLevel = 'U';
    else if (/O[\s_-]Level|^O[\s_-]|_O_/i.test(sheetName)) sheetLevel = 'O';

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    rows.forEach(row => {
      // Find question text
      const qText = row['Question Text'] || row['Question'] || row['Question Description'] || row['question'] || '';
      if (!qText || String(qText).trim().length < 3) return;

      const lvl = (row['Level'] || row['level'] || sheetLevel || 'O').toUpperCase();
      const sec = row['Section'] || row['section'] || fileSec || 'Final Finish QA';
      const cat = row['Category'] || row['category'] || 'General QA';
      const ans = String(row['Correct Answer'] || row['Answer'] || row['correctAnswer'] || 'A').trim().toUpperCase().charAt(0) || 'A';

      const optA = row['Option A'] || row['Option 1'] || row['Opt A'] || row['A'] || '';
      const optB = row['Option B'] || row['Option 2'] || row['Opt B'] || row['B'] || '';
      const optC = row['Option C'] || row['Option 3'] || row['Opt C'] || row['C'] || '';
      const optD = row['Option D'] || row['Option 4'] || row['Opt D'] || row['D'] || '';

      const opts = [];
      if (optA) opts.push({ key: 'A', text: String(optA).trim() });
      if (optB) opts.push({ key: 'B', text: String(optB).trim() });
      if (optC) opts.push({ key: 'C', text: String(optC).trim() });
      if (optD) opts.push({ key: 'D', text: String(optD).trim() });

      if (opts.length >= 2) {
        questions.push({
          id: row['Question ID'] || row['id'] || `${lvl}_${sec.replace(/\s+/g, '_')}_${questions.length + 1}`,
          level: lvl,
          section: sec,
          category: cat,
          question: String(qText).trim(),
          options: opts,
          correctAnswer: ['A', 'B', 'C', 'D'].includes(ans) ? ans : 'A'
        });
      }
    });
  });

  return questions;
}

async function handleQuestionFileUpload(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  let totalImported = 0;
  let fileCount = 0;
  const errors = [];

  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    const name = file.name;

    try {
      if (name.endsWith('.docx')) {
        if (typeof mammoth === 'undefined') {
          throw new Error('Mammoth.js library is not loaded. Please check internet connection or mammoth.browser.min.js.');
        }
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        const qs = parseDocxText(result.value, name);
        if (qs.length === 0) {
          errors.push(`${name}: No questions could be extracted.`);
        } else {
          qs.forEach(q => {
            if (!QUESTION_BANK[q.level]) QUESTION_BANK[q.level] = [];
            QUESTION_BANK[q.level].push(q);
          });
          totalImported += qs.length;
          fileCount++;
        }
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        if (typeof XLSX === 'undefined') {
          throw new Error('XLSX library is not loaded.');
        }
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const qs = parseExcelQuestions(workbook, name);
        if (qs.length === 0) {
          errors.push(`${name}: No valid questions found in Excel sheet.`);
        } else {
          qs.forEach(q => {
            if (!QUESTION_BANK[q.level]) QUESTION_BANK[q.level] = [];
            QUESTION_BANK[q.level].push(q);
          });
          totalImported += qs.length;
          fileCount++;
        }
      } else if (name.endsWith('.json')) {
        const text = await file.text();
        const data = JSON.parse(text);
        let qs = [];
        if (Array.isArray(data)) {
          qs = data;
        } else if (data.questionBank) {
          ['L', 'U', 'O'].forEach(lvl => {
            if (Array.isArray(data.questionBank[lvl])) qs.push(...data.questionBank[lvl]);
          });
        } else if (data.L || data.U || data.O) {
          ['L', 'U', 'O'].forEach(lvl => {
            if (Array.isArray(data[lvl])) qs.push(...data[lvl]);
          });
        }

        if (qs.length === 0) {
          errors.push(`${name}: No questions array found in JSON.`);
        } else {
          qs.forEach(q => {
            const lvl = (q.level || 'O').toUpperCase();
            if (!QUESTION_BANK[lvl]) QUESTION_BANK[lvl] = [];
            QUESTION_BANK[lvl].push(q);
          });
          totalImported += qs.length;
          fileCount++;
        }
      } else {
        errors.push(`${name}: Unsupported file type (use .docx, .xlsx, .xls, or .json).`);
      }
    } catch (err) {
      console.error('File parse error for ' + name, err);
      errors.push(`${name}: ${err.message}`);
    }
  }

  // Reset file input so user can re-upload same file if desired
  event.target.value = '';

  if (totalImported > 0) {
    saveCustomQuestionsToServer();
    renderQuestionsManager();
    showToast(`Successfully imported ${totalImported} questions from ${fileCount} file(s)!`);
  }

  if (errors.length > 0) {
    alert(`Upload status:\n` + errors.join('\n'));
  }
}

// Backward compatibility alias
function handleDocxUpload(event) {
  handleQuestionFileUpload(event);
}

// ---------------------------------------------------------------------
// QA SECTIONS & DEPARTMENT EXPLORER (/control-center/sections)
// ---------------------------------------------------------------------
function renderSectionsExplorer(targetSecKey) {
  if (targetSecKey) currentActiveSectionKey = targetSecKey;
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === currentActiveSectionKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;
  const records = getStoredRecords();

  // All employees in this section
  const sectionEmps = EMPLOYEES.filter(emp => normalizeSectionName(emp.section) === normSec);

  // All questions in this section across L, U, O
  const allSectionQs = [];
  ['L', 'U', 'O'].forEach(lvl => {
    (QUESTION_BANK[lvl] || []).forEach(q => {
      if (normalizeSectionName(q.section) === normSec) {
        allSectionQs.push(q);
      }
    });
  });

  // Calculate section metrics
  let completedCount = 0;
  let totalScorePct = 0;
  let passCount = 0;

  sectionEmps.forEach(emp => {
    const rec = records[emp.empNo];
    if (rec && rec.isCompleted) {
      completedCount++;
      totalScorePct += (rec.markPct || 0);
      if (rec.status && !rec.status.includes('Fail') && !rec.status.includes('Terminated')) {
        passCount++;
      }
    }
  });

  const avgScore = completedCount > 0 ? (totalScorePct / completedCount).toFixed(1) : '0';
  const passRate = completedCount > 0 ? Math.round((passCount / completedCount) * 100) : 0;

  // 1. Render Section Selector Cards Grid
  const pillsContainer = document.getElementById('sectionPillsGrid');
  if (pillsContainer) {
    pillsContainer.innerHTML = QA_SECTIONS_LIST.map(sec => {
      const empCount = EMPLOYEES.filter(e => normalizeSectionName(e.section) === sec.normName).length;
      let qCount = 0;
      ['L', 'U', 'O'].forEach(lvl => {
        qCount += (QUESTION_BANK[lvl] || []).filter(q => normalizeSectionName(q.section) === sec.normName).length;
      });

      const isActive = sec.id === currentSec.id;
      return `
        <div class="sec-pill-card ${isActive ? 'active' : ''}" onclick="selectExplorerSection('${sec.id}')">
          <div class="sec-pill-icon" style="font-weight: 800; font-size: 0.82rem;">${sec.code}</div>
          <div class="sec-pill-info">
            <div class="sec-pill-title">${sec.title}</div>
            <div class="sec-pill-meta">${empCount} Employees &bull; ${qCount} Questions</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 2. Render Active Section Banner Header
  const bannerHeader = document.getElementById('sectionBannerHeader');
  if (bannerHeader) {
    bannerHeader.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="font-size: 1.1rem; font-weight: 800; background: #EFF6FF; color: var(--primary-color); border: 1.5px solid #BFDBFE; width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center;">
            ${currentSec.code}
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <h2 style="font-size: 1.35rem; font-weight: 800; color: var(--text-main); margin: 0;">${currentSec.title}</h2>
              <span class="brand-badge" style="background: var(--primary-color); font-size: 0.72rem;">QUALITY CONTROL</span>
            </div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 2px;">
              Yokohama Industrial QA &bull; Normalization: <code>${currentSec.normName}</code>
            </div>
          </div>
        </div>
        <button class="btn-primary" style="padding: 8px 16px; font-size: 0.85rem; background: #059669; border-color: #059669; display: flex; align-items: center; gap: 6px;" onclick="exportCurrentSectionExcel()">
          <span>Download ${currentSec.title} Excel</span>
        </button>
      </div>
    `;
  }

  // 3. Render Section Stats Grid
  const statsGrid = document.getElementById('sectionStatsGrid');
  if (statsGrid) {
    statsGrid.innerHTML = `
      <div class="stat-card">
        <div class="stat-title">Section Employees</div>
        <div class="stat-value" style="color: var(--primary-color);">${sectionEmps.length}</div>
        <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px;">Assigned in Master Database</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Section Questions</div>
        <div class="stat-value" style="color: #6366F1;">${allSectionQs.length}</div>
        <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px;">Across L, U &amp; O levels</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Completed Exams</div>
        <div class="stat-value" style="color: #059669;">${completedCount}</div>
        <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px;">${sectionEmps.length - completedCount} pending completion</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Average Score</div>
        <div class="stat-value" style="color: ${avgScore >= 60 ? '#059669' : '#D97706'};">${avgScore}%</div>
        <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px;">Pass Rate: <strong>${passRate}%</strong></div>
      </div>
    `;
  }

  // Update badge counters
  const empBadge = document.getElementById('secEmpCountBadge');
 if (empBadge) empBadge.innerText = sectionEmps.length;
  const qBadge = document.getElementById('secQCountBadge');
 if (qBadge) qBadge.innerText = allSectionQs.length;

  // Render active inner tab
  renderActiveSectionTab();
}

function selectExplorerSection(secKey) {
  renderSectionsExplorer(secKey);
}

function switchSectionTab(tabName) {
  currentActiveSectionTab = tabName;
  ['employees', 'skills', 'questions'].forEach(t => {
    const btn = document.getElementById(`secTabBtn${capitalize(t)}`);
    const pane = document.getElementById(`secPane${capitalize(t)}`);
    if (btn) {
      if (t === tabName) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    if (pane) {
      pane.style.display = t === tabName ? 'block' : 'none';
    }
  });

  renderActiveSectionTab();
}

function renderActiveSectionTab() {
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === currentActiveSectionKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;

  if (currentActiveSectionTab === 'employees') {
    filterSectionEmployees();
  } else if (currentActiveSectionTab === 'skills') {
    renderSectionSkillMarks(normSec);
  } else if (currentActiveSectionTab === 'questions') {
    filterSectionQuestions();
  }
}

function filterSectionEmployees() {
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === currentActiveSectionKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;
  const records = getStoredRecords();
  const searchInput = document.getElementById('explorerSecEmpSearchInput') || document.getElementById('secEmpSearchInput');
  const q = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const sectionEmps = EMPLOYEES.filter(emp => {
    if (normalizeSectionName(emp.section) !== normSec) return false;
    if (!q) return true;
    return (
      emp.empNo.toLowerCase().includes(q) ||
      emp.name.toLowerCase().includes(q) ||
      (emp.currentLevel && emp.currentLevel.toLowerCase().includes(q)) ||
      (emp.qualification && emp.qualification.toLowerCase().includes(q))
    );
  });

  const countElem = document.getElementById('explorerSecEmpTableCount') || document.getElementById('secEmpTableCount');
  if (countElem) countElem.innerText = sectionEmps.length;

  const tbody = document.getElementById('explorerSecEmpTableBody') || document.getElementById('secEmpTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (sectionEmps.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" style="text-align: center; padding: 24px; color: var(--text-muted);">
          No employees found matching the search criteria in ${currentSec.title}.
        </td>
      </tr>
    `;
    return;
  }

  sectionEmps.forEach(emp => {
    const rec = records[emp.empNo] || {};
    const tr = document.createElement('tr');

    const statusBadge = rec.isCompleted
      ? `<span class="${rec.status && rec.status.includes('Terminated') ? 'badge-fail' : 'badge-pass'}">${rec.status || 'Completed'}</span>`
      : rec.inProgress
      ? `<span class="badge-pending">In Progress (${rec.tabSwitchCount || 0} Sw)</span>`
      : `<span style="color: #94A3B8;">Not Started</span>`;

    const hasRecord = rec.isCompleted || rec.inProgress;
    const actionBtn = `
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #DC2626; border-color: #DC2626;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download Official PDF Report">PDF</button>
        <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #059669; border-color: #059669;" onclick="openOjtModalForEmployee('${emp.empNo}')">OJT Form</button>
        ${hasRecord ? `<button class="btn-reset" style="padding: 3px 8px; font-size: 0.75rem;" onclick="confirmAndResetExam('${emp.empNo}', '${emp.name.replace(/'/g, "\\'")}')">Reset</button>` : ''}
      </div>
    `;

    tr.innerHTML = `
      <td><strong>${emp.empNo}</strong></td>
      <td><strong>${emp.name}</strong></td>
      <td><span class="skill-level-badge" style="background: #EFF6FF; color: var(--primary-color); border: 1px solid #BFDBFE;">${emp.currentLevel || 'I'} Level</span></td>
      <td>${emp.qualification || '-'}</td>
      <td>${emp.doj || '-'} <small style="color: var(--text-muted); display: block;">${emp.yearExp || ''}</small></td>
      <td>${rec.uMark !== undefined ? rec.uMark : '-'}</td>
      <td>${rec.lMark !== undefined ? rec.lMark : '-'}</td>
      <td>${rec.oMark !== undefined ? rec.oMark : '-'}</td>
      <td><strong style="color: var(--text-main); font-size: 0.95rem;">${rec.totalMark !== undefined ? rec.totalMark : '-'}</strong></td>
      <td><strong>${rec.totalMark !== undefined ? (rec.totalMark >= 21 ? 'Pass (≥21)' : 'Retest (<21)') : '-'}</strong></td>
      <td>${statusBadge}</td>
      <td>${rec.attemptDate || '-'}</td>
      <td>${actionBtn}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSectionSkillMarks(normSec) {
  const container = document.getElementById('secSkillsBreakdownContainer');
  if (!container) return;

  const sectionEmps = EMPLOYEES.filter(e => normalizeSectionName(e.section) === normSec);
  const records = getStoredRecords();

  const skillGroups = {
    'I': { title: 'I Level (Trainee)', color: '#3B82F6', total: 0, completed: 0, totalPct: 0, pass: 0 },
    'L': { title: 'L Level (Basic)', color: '#10B981', total: 0, completed: 0, totalPct: 0, pass: 0 },
    'U': { title: 'U Level (Skilled)', color: '#F59E0B', total: 0, completed: 0, totalPct: 0, pass: 0 },
    'O': { title: 'O Level (Expert)', color: '#8B5CF6', total: 0, completed: 0, totalPct: 0, pass: 0 }
  };

  sectionEmps.forEach(emp => {
    const lvl = (emp.currentLevel || 'I').toUpperCase().trim();
    const group = skillGroups[lvl] || skillGroups['I'];
    group.total++;

    const rec = records[emp.empNo];
    if (rec && rec.isCompleted) {
      group.completed++;
      group.totalPct += (rec.markPct || 0);
      if (rec.status && !rec.status.includes('Fail') && !rec.status.includes('Terminated')) {
        group.pass++;
      }
    }
  });

  const cardsHtml = Object.keys(skillGroups).map(lvlKey => {
    const g = skillGroups[lvlKey];
    const avgScore = g.completed > 0 ? (g.totalPct / g.completed).toFixed(1) : '0';
    const passRate = g.completed > 0 ? Math.round((g.pass / g.completed) * 100) : 0;
    const completionRate = g.total > 0 ? Math.round((g.completed / g.total) * 100) : 0;

    return `
      <div class="skill-matrix-card level-${lvlKey}">
        <div class="skill-matrix-header">
          <span class="skill-level-badge" style="background: ${g.color}15; color: ${g.color}; border: 1px solid ${g.color}40;">
            ${g.title}
          </span>
          <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);">
            ${g.total} Employees
          </span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px;">
          <div class="skill-matrix-stat">${avgScore}%</div>
          <span style="font-size: 0.78rem; color: var(--text-muted);">Avg Mark Obtained</span>
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 12px;">
          Completed: <strong>${g.completed} / ${g.total}</strong> &bull; Pass Rate: <strong>${passRate}%</strong>
        </div>
        <!-- Progress bar -->
        <div style="background: #E2E8F0; height: 8px; border-radius: 4px; overflow: hidden;">
          <div style="background: ${g.color}; width: ${completionRate}%; height: 100%; border-radius: 4px; transition: width 0.3s ease;"></div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div style="margin-bottom: 18px;">
      <h3 style="font-size: 1.05rem; font-weight: 700; color: var(--text-main); margin-bottom: 4px;">
        ILUO Skill Level Competency &amp; Mark Distribution
      </h3>
      <p style="font-size: 0.83rem; color: var(--text-muted);">
        Detailed assessment marks and completion metrics aggregated by Employee Skill Level (I, L, U, O) in this section
      </p>
    </div>
    <div class="skills-cards-grid">
      ${cardsHtml}
    </div>
  `;
}

function filterSectionQuestions() {
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === currentActiveSectionKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;
  const container = document.getElementById('secQuestionsListContainer');
  if (!container) return;

  const searchInput = document.getElementById('secQSearchInput');
  const levelSelect = document.getElementById('secQLevelSelect');
  const catSelect = document.getElementById('secQCategorySelect');

  const qText = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const levelFilter = levelSelect ? levelSelect.value : 'ALL';
  const catFilter = catSelect ? catSelect.value : 'ALL';

  // Gather questions for this section
  const allSectionQs = [];
  ['L', 'U', 'O'].forEach(lvl => {
    if (levelFilter !== 'ALL' && lvl !== levelFilter) return;
    (QUESTION_BANK[lvl] || []).forEach(q => {
      if (normalizeSectionName(q.section) === normSec) {
        allSectionQs.push(q);
      }
    });
  });

  // Filter questions
  const filtered = allSectionQs.filter(q => {
    if (catFilter !== 'ALL') {
      const qCat = (q.category || '').toLowerCase();
      const filterCat = catFilter.toLowerCase();
      if (!qCat.includes(filterCat)) return false;
    }
    if (qText) {
      const titleMatch = (q.question || '').toLowerCase().includes(qText);
      const catMatch = (q.category || '').toLowerCase().includes(qText);
      const optMatch = (q.options || []).some(opt => (opt.text || '').toLowerCase().includes(qText));
      return titleMatch || catMatch || optMatch;
    }
    return true;
  });

  const countElem = document.getElementById('secQFilteredCount');
 if (countElem) countElem.innerText = filtered.length;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 36px; background: #F8FAFC; border: 1px dashed var(--border-color); border-radius: var(--radius-md); color: var(--text-muted);">
        No questions found in ${currentSec.title} matching the selected level/category filters.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((q, idx) => {
    const lvlColor = q.level === 'O' ? '#8B5CF6' : q.level === 'U' ? '#F59E0B' : '#10B981';
    return `
      <div class="sec-q-card">
        <div class="sec-q-header">
          <div class="sec-q-badges">
            <span class="skill-level-badge" style="background: ${lvlColor}15; color: ${lvlColor}; border: 1px solid ${lvlColor}40;">
              ${q.level} Level
            </span>
            <span style="font-size: 0.75rem; background: #F1F5F9; color: var(--text-muted); padding: 3px 8px; border-radius: 4px; font-weight: 600;">
              ${q.category || 'General QA'}
            </span>
            <span style="font-size: 0.72rem; color: #94A3B8; font-family: monospace;">${q.id}</span>
          </div>
          <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">Question #${idx + 1}</span>
        </div>
        <div class="sec-q-title">${q.question}</div>
        <div class="sec-q-options">
          ${(q.options || []).map(opt => {
            const isCorrect = (opt.key === q.correctAnswer);
            return `
              <div class="sec-q-option-item ${isCorrect ? 'correct-answer' : ''}">
                <strong style="min-width: 18px;">${opt.key}.</strong>
                <span>${opt.text}</span>
                ${isCorrect ? '<span style="margin-left: auto; font-size: 0.78rem; font-weight: 800; color: #059669;">Correct</span>' : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function exportCurrentSectionExcel(targetSecKey) {
  const secKey = targetSecKey || currentActiveSectionKey || 'warehouse';
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === secKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;
  const records = getStoredRecords();

  const sectionEmps = EMPLOYEES.filter(emp => normalizeSectionName(emp.section) === normSec);

  // Sheet 1: Employees & Marks
  const allOjt = getStoredOjtRecords();
  const empSheetData = sectionEmps.length > 0 ? sectionEmps.map((emp, index) => {
    const rec = records[emp.empNo] || {};
    const ojt = allOjt[emp.empNo] || {};
    const hasOjt = ojt.totalScore !== undefined || ojt.scorePct !== undefined;
    const examStatus = rec.status || (rec.inProgress ? "In Progress" : "Not Started");
    const ojtStatus = hasOjt ? (ojt.qualificationStatus || (ojt.scorePct >= 70 ? "Qualified" : "Not Qualified")) : "Pending";
    return {
      "S.No": index + 1,
      "Employee No": emp.empNo,
      "Name": emp.name,
      "Department": emp.dept,
      "Section": emp.section,
      "Skill Level": emp.currentLevel || "I",
      "Qualification": emp.qualification || "",
      "DOJ": emp.doj || "",
      "Experience": emp.yearExp || "",
      "U Mark": rec.uMark !== undefined ? rec.uMark : 0,
      "L Mark": rec.lMark !== undefined ? rec.lMark : 0,
      "O Mark": rec.oMark !== undefined ? rec.oMark : 0,
      "Total Mark": rec.totalMark !== undefined ? rec.totalMark : 0,
      "Exam Percentage": rec.markPct !== undefined ? rec.markPct + "%" : "0%",
      "Tab Switches": rec.tabSwitchCount || 0,
      "Exam Status": examStatus,
      "OJT Score": hasOjt ? `${ojt.totalScore}/${ojt.maxScore || 50}` : "-",
      "OJT %": hasOjt ? `${ojt.scorePct}%` : "-",
      "OJT Status": ojtStatus,
      "Attempt Date": rec.attemptDate || ""
    };
  }) : [{ "Notice": `No registered employees currently under ${currentSec.title}.` }];

  // Sheet 2: Section Questions Bank
  const allSectionQs = [];
  ['L', 'U', 'O'].forEach(lvl => {
    (QUESTION_BANK[lvl] || []).forEach(q => {
      if (normalizeSectionName(q.section) === normSec) {
        allSectionQs.push(q);
      }
    });
  });

  const qSheetData = allSectionQs.map((q, idx) => ({
    "Q.No": idx + 1,
    "Question ID": q.id,
    "Level": q.level,
    "Section": q.section,
    "Category": q.category || "General",
    "Question Text": q.question,
    "Option A": (q.options && q.options[0]) ? q.options[0].text : "",
    "Option B": (q.options && q.options[1]) ? q.options[1].text : "",
    "Option C": (q.options && q.options[2]) ? q.options[2].text : "",
    "Option D": (q.options && q.options[3]) ? q.options[3].text : "",
    "Correct Answer": q.correctAnswer
  }));

  const cleanTitle = currentSec.title.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Yokohama_${cleanTitle}_Report_${new Date().toISOString().split('T')[0]}`;

  try {
    if (typeof XLSX !== 'undefined') {
      const workbook = XLSX.utils.book_new();
      const wsEmps = XLSX.utils.json_to_sheet(empSheetData);
      XLSX.utils.book_append_sheet(workbook, wsEmps, "Employees & Marks");

      if (qSheetData.length > 0) {
        const wsQs = XLSX.utils.json_to_sheet(qSheetData);
        XLSX.utils.book_append_sheet(workbook, wsQs, "Section Question Bank");
      }

      XLSX.writeFile(workbook, `${filename}.xlsx`);
 showToast(`${currentSec.title} Excel report downloaded successfully!`);
    } else {
      exportDataToCSV(empSheetData, `${filename}.csv`);
 showToast(`${currentSec.title} downloaded as CSV report.`);
    }
  } catch (err) {
    console.error('Section export error:', err);
    exportDataToCSV(empSheetData, `${filename}.csv`);
 showToast(`${currentSec.title} downloaded as CSV report.`);
  }
}

function exportCurrentSectionCSV(targetSecKey) {
  const secKey = targetSecKey || currentActiveSectionKey || 'warehouse';
  const currentSec = QA_SECTIONS_LIST.find(s => s.id === secKey) || QA_SECTIONS_LIST[0];
  const normSec = currentSec.normName;
  const records = getStoredRecords();

  const sectionEmps = EMPLOYEES.filter(emp => normalizeSectionName(emp.section) === normSec);

  const empData = sectionEmps.length > 0 ? sectionEmps.map((emp, index) => {
    const rec = records[emp.empNo] || {};
    return {
      "S.No": index + 1,
      "Employee No": emp.empNo,
      "Name": emp.name,
      "Department": emp.dept,
      "Section": emp.section,
      "Skill Level": emp.currentLevel || "I",
      "DOJ": emp.doj || "",
      "U Mark": rec.uMark !== undefined ? rec.uMark : 0,
      "L Mark": rec.lMark !== undefined ? rec.lMark : 0,
      "O Mark": rec.oMark !== undefined ? rec.oMark : 0,
      "Total Mark": rec.totalMark !== undefined ? rec.totalMark : 0,
      "Percentage": rec.markPct !== undefined ? rec.markPct + "%" : "0%",
      "Tab Switches": rec.tabSwitchCount || 0,
      "Status": rec.status || (rec.inProgress ? "In Progress" : "Not Started"),
      "Attempt Date": rec.attemptDate || ""
    };
  }) : [{ "Notice": `No registered employees under ${currentSec.title}.` }];

  const cleanTitle = currentSec.title.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Yokohama_${cleanTitle}_Report_${new Date().toISOString().split('T')[0]}.csv`;
  exportDataToCSV(empData, filename);
 showToast(`${currentSec.title} CSV report downloaded successfully!`);
}

// ---------------------------------------------------------------------
// TRAINING REQUIREMENTS & SKILL GAP MATRIX
// ---------------------------------------------------------------------
const STORAGE_KEY_TRAINING = 'yokohama_training_status_v1';

function getStoredTrainingRecords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_TRAINING)) || {};
  } catch (e) {
    return {};
  }
}

function saveTrainingRecord(empNo, data) {
  const all = getStoredTrainingRecords();
  all[empNo] = { ...(all[empNo] || {}), ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY_TRAINING, JSON.stringify(all));
}

const SECTION_TRAINING_MODULES = {
  'warehouse qa': [
    'WH-QA-01: Finished Goods FIFO & Barcode Scanning SOP',
    'WH-QA-02: Visual Defect Segregation & Loading Inspection',
    'WH-QA-03: Material Handling Safety & Damage Control'
  ],
  'final finish qa': [
    'FF-QA-01: Visual Defect Classification & Critical Defect Standards',
    'FF-QA-02: Casing, Sidewall & Tread Surface Inspection SOP',
    'FF-QA-03: Barcode Verification & Scrap Segregation Control'
  ],
  'tire building qa': [
    'TB-QA-01: Green Tire Dimension Checks & Cord Angle Alignment',
    'TB-QA-02: Carcass Splice & Turn-up Inspection Protocols',
    'TB-QA-03: Component Symmetry & Bead Placement Verification'
  ],
  'tire curing qa': [
    'TC-QA-01: Bladder Inspection & Cure Temperature Monitoring',
    'TC-QA-02: Mold Venting, Segment Alignment & Pressure Specs',
    'TC-QA-03: Post-Cure Visual Audit & Blister/Under-cure Defect Prevention'
  ],
  'solid tire qa': [
    'ST-QA-01: Solid Tire Core Bonding & Steel Ring Alignment',
    'ST-QA-02: Base / Tread Compound Uniformity & Visual QA Standard',
    'ST-QA-03: Post-Mold Cooling, Flash Trimming & Inspection Checklist'
  ],
  'final finish rro & alt qa': [
    'RA-QA-01: Radial Runout (RRO) & Lateral Runout Measurement Standards',
    'RA-QA-02: Dynamic Balance & Force Variation Machine Calibration',
    'RA-QA-03: Accelerated Life Testing (ALT) Rig Protocols & Diagnostics'
  ],
  'preparatory qa': [
    'PR-QA-01: Raw Compound Mooney Viscosity & Rheometer Protocols',
    'PR-QA-02: Calender Fabric & Steel Cord Caliper Inspection',
    'PR-QA-03: Extruder Profile Dimensional Verification & Weight Control'
  ],
  'fid inspector qa': [
    'FD-QA-01: Final Inspection Defect Standard & Audit Log Documentation',
    'FD-QA-02: Customer Delivery Release Checklists & Quality Sign-Off',
    'FD-QA-03: Plant PDI Audit & Non-Conformance Escalation SOP'
  ]
};

function computeEmployeeTrainingNeed(emp, rec, trainingRec, ojt) {
  const normSec = normalizeSectionName(emp.section);
  const modules = SECTION_TRAINING_MODULES[normSec] || [
    'QA-GEN-01: Quality SOP Standard Work & Visual Inspection',
    'QA-GEN-02: Plant 5S, Safety & Defect Categorization'
  ];

  const currLevel = emp.currentLevel || 'I';
  const status = trainingRec && trainingRec.status ? trainingRec.status : 'PENDING';
  const scheduledDate = trainingRec && trainingRec.date ? trainingRec.date : '';

  let priority = 'PROGRESSION';
  let targetLevel = 'L Level';
  let finding = '';
  let assignedModule = modules[0];

  const hasExam = !!(rec && rec.isCompleted);
  const examFailed = rec && (rec.status === 'Failed' || (rec.markPct !== undefined && rec.markPct < 70) || (rec.tabSwitchCount && rec.tabSwitchCount > 3));
  const examPassed = rec && (rec.status === 'Passed' || (rec.markPct !== undefined && rec.markPct >= 70));
  const examMarkVal = rec && rec.totalMark !== undefined ? rec.totalMark : 0;
  const examMarkStr = hasExam ? `${examMarkVal} Marks` : (rec && rec.inProgress ? 'In Progress' : 'Not Started');

  const hasOjt = !!(ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined));
  const ojtFailed = hasOjt && (ojt.qualificationStatus === 'Not Qualified' || (ojt.scorePct !== undefined && ojt.scorePct < 70));
  const ojtPassed = hasOjt && (ojt.qualificationStatus === 'Qualified' || (ojt.scorePct !== undefined && ojt.scorePct >= 70));
  const ojtScoreVal = hasOjt ? ojt.totalScore : 0;
  const ojtMaxVal = hasOjt ? (ojt.maxScore || 50) : 50;
  const ojtMarkStr = hasOjt ? `${ojtScoreVal}/${ojtMaxVal} Marks` : 'Pending';
  const ojtStatus = hasOjt ? (ojt.qualificationStatus || (ojtPassed ? 'Qualified' : 'Not Qualified')) : 'Pending';

  if (currLevel === 'I') targetLevel = 'L Level (Basic)';
  else if (currLevel === 'L') targetLevel = 'U Level (Independent)';
  else if (currLevel === 'U') targetLevel = 'O Level (Evaluator)';
  else targetLevel = 'Master Trainer (ILUO Lead)';

  if (examFailed || ojtFailed) {
    priority = 'CRITICAL';
    targetLevel = `Retest (${rec && rec.targetLevel ? rec.targetLevel : currLevel})`;
    if (examFailed && ojtFailed) {
      finding = `MCQ: ${examMarkVal} Marks (Failed standard) &bull; OJT: ${ojtScoreVal}/${ojtMaxVal} Marks (Not Qualified) &bull; Full Retest & Retraining`;
    } else if (ojtFailed) {
      finding = `MCQ: ${examMarkVal} Marks (Passed) &bull; OJT: ${ojtScoreVal}/${ojtMaxVal} Marks (Not Qualified) &bull; Practical Checkpoints Refresher Required`;
    } else {
      finding = `MCQ: ${examMarkVal} Marks (Failed standard) &bull; OJT: ${hasOjt ? `${ojtScoreVal}/${ojtMaxVal} Marks` : 'Pending'} &bull; MCQ Retest Required`;
    }
    assignedModule = modules[1] || modules[0];
  } else if (examPassed) {
    priority = 'PROGRESSION';
    if (ojtPassed) {
      finding = `MCQ: ${examMarkVal} Marks &bull; OJT: ${ojtScoreVal}/${ojtMaxVal} Marks (Qualified) &bull; Recommended for ${targetLevel} Advancement`;
    } else {
      finding = `MCQ: ${examMarkVal} Marks (Passed) &bull; Practical OJT Evaluation Pending`;
    }
    assignedModule = modules[2] || modules[0];
  } else {
    // Not yet attempted
    if (currLevel === 'I') {
      priority = 'PROGRESSION';
      finding = 'Learner (I Level) - Foundational Operator Qualification Training required';
      assignedModule = modules[0];
    } else if (currLevel === 'L') {
      priority = 'PROGRESSION';
      finding = 'Supervised Operator (L Level) - Eligible for Independent Skilled qualification';
      assignedModule = modules[1] || modules[0];
    } else if (currLevel === 'U') {
      priority = 'PROGRESSION';
      finding = 'Skilled Operator (U Level) - Training for Evaluator / Trainer certification';
      assignedModule = modules[2] || modules[0];
    } else {
      priority = 'REFRESHER';
      targetLevel = 'O Level (Master)';
      finding = 'Expert (O Level) - Annual QA Calibration & Defect Analysis refresher';
      assignedModule = modules[0];
    }
  }

  return {
    empNo: emp.empNo,
    name: emp.name,
    section: emp.section,
    normSection: normSec,
    currentLevel: currLevel,
    targetLevel,
    examMark: examMarkStr,
    hasExam,
    examPassed,
    examFailed,
    ojtMark: ojtMarkStr,
    hasOjt,
    ojtPassed,
    ojtFailed,
    ojtStatus,
    priority, // CRITICAL | PROGRESSION | REFRESHER
    finding,
    assignedModule,
    status, // PENDING | SCHEDULED | COMPLETED
    scheduledDate
  };
}

function getAllTrainingDataset() {
  const records = getStoredRecords();
  const allOjt = getStoredOjtRecords();
  const trainingRecords = getStoredTrainingRecords();

  return EMPLOYEES.map(emp => {
    const rec = records[emp.empNo];
    const ojt = allOjt[emp.empNo];
    const trainingRec = trainingRecords[emp.empNo];
    return computeEmployeeTrainingNeed(emp, rec, trainingRec, ojt);
  });
}

function renderTrainingRequirements() {
  filterTrainingRequirements();
}

function filterTrainingRequirements() {
  const searchInput = document.getElementById('trainingSearchInput');
  const secFilter = document.getElementById('trainingSectionFilter');
  const prioFilter = document.getElementById('trainingPriorityFilter');
  const statusFilter = document.getElementById('trainingStatusFilter');
  const tbody = document.getElementById('trainingTableBody');
  const countEl = document.getElementById('trainingRowCount');

  if (!tbody) return;

  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const selectedSec = secFilter ? secFilter.value : 'ALL';
  const selectedPrio = prioFilter ? prioFilter.value : 'ALL';
  const selectedStatus = statusFilter ? statusFilter.value : 'ALL';

  const dataset = getAllTrainingDataset();

  const filtered = dataset.filter(item => {
    if (selectedSec !== 'ALL' && item.normSection !== selectedSec) return false;
    if (selectedPrio !== 'ALL' && item.priority !== selectedPrio) return false;
    if (selectedStatus !== 'ALL' && item.status !== selectedStatus) return false;

    if (query) {
      const matchName = item.name.toLowerCase().includes(query);
      const matchId = item.empNo.toLowerCase().includes(query);
      const matchSec = item.section.toLowerCase().includes(query);
      const matchMod = item.assignedModule.toLowerCase().includes(query);
      return matchName || matchId || matchSec || matchMod;
    }
    return true;
  });

 if (countEl) countEl.innerText = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" style="text-align: center; padding: 36px; color: var(--text-muted);">
          No training requirement records found matching the active filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((item, index) => {
    const prioBadge = item.priority === 'CRITICAL'
      ? `<span style="background: #FEE2E2; color: #DC2626; border: 1px solid #FCA5A5; padding: 3px 8px; border-radius: 4px; font-weight: 800; font-size: 0.72rem; letter-spacing: 0.5px;">CRITICAL</span>`
      : item.priority === 'PROGRESSION'
      ? `<span style="background: #EFF6FF; color: #0284C7; border: 1px solid #BFDBFE; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.72rem;">PROGRESSION</span>`
      : `<span style="background: #F3E8FF; color: #7C3AED; border: 1px solid #DDD6FE; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.72rem;">REFRESHER</span>`;

    const statusBadge = item.status === 'COMPLETED'
      ? `<span style="background: #DCFCE7; color: #166534; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">Completed</span>`
      : item.status === 'SCHEDULED'
      ? `<span style="background: #DBEAFE; color: #1E40AF; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">Scheduled</span>`
      : `<span style="background: #FEF3C7; color: #D97706; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">Pending</span>`;

    let actionHtml = '';
    if (item.status === 'PENDING') {
      actionHtml = `
        <button class="btn-primary" style="padding: 4px 10px; font-size: 0.76rem; background: #0284C7; border-color: #0284C7;" onclick="toggleTrainingSchedule('${item.empNo}')">
          Schedule
        </button>
      `;
    } else if (item.status === 'SCHEDULED') {
      actionHtml = `
        <div style="display: flex; gap: 4px; justify-content: center;">
          <button class="btn-primary" style="padding: 4px 8px; font-size: 0.74rem; background: #059669; border-color: #059669;" onclick="toggleTrainingComplete('${item.empNo}')">
            Done
          </button>
          <button class="btn-secondary" style="padding: 4px 6px; font-size: 0.74rem;" onclick="resetTrainingStatus('${item.empNo}')">
            Cancel
          </button>
        </div>
      `;
    } else {
      actionHtml = `
        <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.74rem;" onclick="resetTrainingStatus('${item.empNo}')">
          Re-open
        </button>
      `;
    }

    return `
      <tr>
        <td style="font-weight: 700; color: var(--text-muted);">${index + 1}</td>
        <td><strong style="color: #005B9E; font-family: monospace;">${item.empNo}</strong></td>
        <td><strong>${item.name}</strong></td>
        <td><span style="font-size: 0.85rem; color: #475569;">${item.section}</span></td>
        <td>
          <span class="skill-level-badge level-${item.currentLevel}" style="font-size: 0.76rem; padding: 2px 8px;">
            ${item.currentLevel} Level
          </span>
        </td>
        <td>
          <strong style="color: #0284C7; font-size: 0.82rem;">${item.targetLevel}</strong>
        </td>
        <td>
          <span class="${item.hasExam ? (item.examPassed ? 'badge-pass' : 'badge-fail') : ''}" style="font-weight: 700; font-size: 0.8rem;">
            ${item.examMark}
          </span>
        </td>
        <td>
          <span class="${item.hasOjt ? (item.ojtPassed ? 'badge-pass' : 'badge-fail') : ''}" style="font-weight: 700; font-size: 0.8rem; cursor: pointer;" onclick="openOjtModalForEmployee('${item.empNo}')" title="Click to view or edit OJT form">
            ${item.ojtMark}
          </span>
        </td>
        <td style="font-size: 0.82rem; color: #334155;">${item.finding}</td>
        <td style="font-size: 0.82rem; font-weight: 600; color: #0F172A;">${item.assignedModule}</td>
        <td>${prioBadge}</td>
        <td>${statusBadge}</td>
        <td style="text-align: center;">${actionHtml}</td>
      </tr>
    `;
  }).join('');
}

function toggleTrainingSchedule(empNo) {
  const scheduledDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  saveTrainingRecord(empNo, { status: 'SCHEDULED', date: scheduledDate });
 showToast(`Training scheduled for Employee ${empNo} (Target Date: ${scheduledDate})`);
  renderTrainingRequirements();
}

function toggleTrainingComplete(empNo) {
  saveTrainingRecord(empNo, { status: 'COMPLETED', completedAt: new Date().toISOString().split('T')[0] });
 showToast(`Training marked COMPLETED for Employee ${empNo}`);
  renderTrainingRequirements();
}

function resetTrainingStatus(empNo) {
  saveTrainingRecord(empNo, { status: 'PENDING', date: '' });
 showToast(`Training status reset to PENDING for Employee ${empNo}`);
  renderTrainingRequirements();
}

function exportTrainingPlanExcel() {
  const dataset = getAllTrainingDataset();
  const exportData = dataset.map((item, idx) => ({
    "S.No": idx + 1,
    "Employee No": item.empNo,
    "Employee Name": item.name,
    "Section": item.section,
    "Current Skill Level": item.currentLevel,
    "Target Skill Level": item.targetLevel,
    "Exam Mark": item.examMark,
    "OJT Form Mark": item.ojtMark,
    "OJT Status": item.ojtStatus,
    "Assessment Finding": item.finding,
    "Recommended Training Module": item.assignedModule,
    "Training Priority": item.priority,
    "Schedule Status": item.status,
    "Scheduled Target Date": item.scheduledDate || ""
  }));

  const filename = `Yokohama_ILUO_Training_Requirements_Plan_${new Date().toISOString().split('T')[0]}`;

  try {
    if (typeof XLSX !== 'undefined') {
      const workbook = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(exportData);
      XLSX.utils.book_append_sheet(workbook, ws, "Training Requirements Plan");
      XLSX.writeFile(workbook, `${filename}.xlsx`);
 showToast('Training Plan Excel (.xlsx) downloaded successfully!');
    } else {
      exportDataToCSV(exportData, `${filename}.csv`);
 showToast('Downloaded Training Plan as CSV.');
    }
  } catch (err) {
    console.error('Training plan export error:', err);
    exportDataToCSV(exportData, `${filename}.csv`);
  }
}

// ---------------------------------------------------------------------
// ON-THE-JOB TRAINING EVALUATION (OJT) ENGINE (Official D:\OJT 9 Formats)
// ---------------------------------------------------------------------

function getOjtTemplateForSection(secName) {
  if (typeof OJT_OFFICIAL_TEMPLATES === 'undefined') return null;
  const s = normalizeSectionName(secName || '');
  if (s.includes('solid')) return OJT_OFFICIAL_TEMPLATES['86D'];
  if (s.includes('rro') || s.includes('alt')) return OJT_OFFICIAL_TEMPLATES['83D'];
  if (s.includes('preparatory')) return OJT_OFFICIAL_TEMPLATES['85D'];
  if (s.includes('building') || s.includes('tbm')) return OJT_OFFICIAL_TEMPLATES['87D'];
  if (s.includes('curing')) return OJT_OFFICIAL_TEMPLATES['88D'];
  if (s.includes('warehouse') || s.includes('data entry')) return OJT_OFFICIAL_TEMPLATES['89D'];
  if (s.includes('fid')) return OJT_OFFICIAL_TEMPLATES['90D'];
  if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) return OJT_OFFICIAL_TEMPLATES['90G'];
  // Default to Final Finish Repair Associate 84D
  return OJT_OFFICIAL_TEMPLATES['84D'] || Object.values(OJT_OFFICIAL_TEMPLATES)[0];
}

function getStoredOjtRecords() {
  try {
    let ojt = JSON.parse(localStorage.getItem(STORAGE_KEY_OJT));
    if (!ojt || Object.keys(ojt).length < 10) {
      if (typeof YOKOHAMA_SEED_OJT_RECORDS !== 'undefined' && Object.keys(YOKOHAMA_SEED_OJT_RECORDS).length > 0) {
        ojt = { ...YOKOHAMA_SEED_OJT_RECORDS, ...(ojt || {}) };
        localStorage.setItem(STORAGE_KEY_OJT, JSON.stringify(ojt));
      } else {
        ojt = ojt || {};
      }
    }
    return ojt || {};
  } catch (e) {
    return (typeof YOKOHAMA_SEED_OJT_RECORDS !== 'undefined') ? { ...YOKOHAMA_SEED_OJT_RECORDS } : {};
  }
}

async function makeZeroFinishExam() {
  if (confirm('Are you sure you want to RESET ALL EXAMS to 0 Finished (Fresh Assessment Mode)?\n\nAll 236 employees will be set to "Not Started" so they can take their assessments from scratch.')) {
    // 1. Reset client LocalStorage
    localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify({}));
    localStorage.removeItem('iluo_preserve_local');

    // 2. Call server reset API
    try {
      await fetch('/api/records/reset-all', { method: 'POST' });
    } catch (e) {}

    showToast('All 236 exams reset to 0 finished! Fresh assessment mode active.');

    // 3. Re-render UI
    if (document.getElementById('adminTableBody')) {
      const searchInput = document.getElementById('adminSearchInput');
      renderAdminTable(searchInput ? searchInput.value : '');
    }
    if (document.getElementById('secEmpTableBody')) filterSectionTable();
    if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
    if (currentUser) {
      handleRoute();
    }
  }
}
window.makeZeroFinishExam = makeZeroFinishExam;

async function restoreAllCompletedExams() {
  if (confirm('Restore all 234+ completed demo exam records from backup?')) {
    showToast('Restoring demo records from backup...');
    try {
      const res = await fetch('/api/records/restore-demo', { method: 'POST' });
      const data = await res.json();
      if (data.success && data.records) {
        localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(data.records));
        localStorage.setItem('iluo_preserve_local', 'true');
        showToast('Restored 236 demo completed records!');
      } else {
        showToast('Could not restore demo records.');
      }
    } catch (e) {
      showToast('Error restoring demo records: ' + e.message);
    }
    if (document.getElementById('adminTableBody')) {
      const searchInput = document.getElementById('adminSearchInput');
      renderAdminTable(searchInput ? searchInput.value : '');
    }
    if (document.getElementById('secEmpTableBody')) filterSectionTable();
    if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
  }
}
window.restoreAllCompletedExams = restoreAllCompletedExams;

function applyAll234CompletedRecords() {
  restoreAllCompletedExams();
}
window.applyAll234CompletedRecords = applyAll234CompletedRecords;

// ---------------------------------------------------------------------
// DEDICATED ADMIN SECTION & DEPARTMENT EXAM RESET MANAGEMENT
// ---------------------------------------------------------------------
async function resetSectionExams(secIdOrName, customTitle) {
  const sec = QA_SECTIONS_LIST.find(s => s.id === secIdOrName || s.normName === String(secIdOrName).toLowerCase() || s.title.toLowerCase() === String(secIdOrName).toLowerCase());
  const title = customTitle || (sec ? sec.title : secIdOrName);
  const secId = sec ? sec.id : secIdOrName;
  const normName = sec ? sec.normName : String(secIdOrName).toLowerCase().replace(/qa/g, '').trim();

  // Find employees in this section
  const sectionEmps = EMPLOYEES.filter(e => {
    const s = normalizeSectionName(e.section || '');
    return s.includes(normName) || normName.includes(s);
  });

  const count = sectionEmps.length;
  if (!confirm(`Are you sure you want to RESET all exams for Section: "${title}"?\n\nThis will reset ${count} employee records in this section back to "Not Started" so they can take their assessments freshly.`)) {
    return;
  }

  // 1. Delete from local records
  const records = getStoredRecords();
  let clearedCount = 0;
  sectionEmps.forEach(e => {
    if (records[e.empNo]) {
      delete records[e.empNo];
      clearedCount++;
    }
  });
  localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));

  // 2. Call server section reset API
  try {
    const res = await fetch('/api/records/reset-section', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: title, sectionId: secId })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Section "${title}" exams reset successfully! (${count} employees reset to Not Started)`);
    } else {
      showToast(`Section reset completed locally (${count} employees).`);
    }
  } catch (err) {
    showToast(`Section "${title}" reset completed.`);
  }

  // 3. Re-render views
  if (document.getElementById('adminTableBody')) {
    const searchInput = document.getElementById('adminSearchInput');
    renderAdminTable(searchInput ? searchInput.value : '');
  }
  if (document.getElementById('secEmpTableBody')) filterSectionTable();
  if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
  if (typeof updateAdminResetSecInfo === 'function') updateAdminResetSecInfo();
  if (typeof renderSectionsExplorer === 'function' && typeof currentActiveSectionKey !== 'undefined') {
    renderSectionsExplorer(currentActiveSectionKey);
  }
}
window.resetSectionExams = resetSectionExams;

async function resetDepartmentExams(deptName) {
  const normDept = String(deptName || 'QUALITY CONTROL').toUpperCase().trim();
  const deptEmps = EMPLOYEES.filter(e => {
    const d = String(e.dept || 'QUALITY CONTROL').toUpperCase().trim();
    return normDept === 'ALL' || d === normDept || d.includes(normDept) || normDept.includes(d);
  });

  const count = deptEmps.length;
  if (!confirm(`Are you sure you want to RESET all exams for Department: "${normDept}"?\n\nThis will reset ${count} employee records in this department back to "Not Started" so they can take their assessments freshly.`)) {
    return;
  }

  // 1. Delete from local records
  const records = getStoredRecords();
  deptEmps.forEach(e => {
    if (records[e.empNo]) delete records[e.empNo];
  });
  localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));

  // 2. Call server department reset API
  try {
    const res = await fetch('/api/records/reset-department', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ department: normDept })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Department "${normDept}" exams reset successfully! (${count} employees reset to Not Started)`);
    } else {
      showToast(`Department reset completed locally (${count} employees).`);
    }
  } catch (err) {
    showToast(`Department "${normDept}" reset completed.`);
  }

  // 3. Re-render views
  if (document.getElementById('adminTableBody')) {
    const searchInput = document.getElementById('adminSearchInput');
    renderAdminTable(searchInput ? searchInput.value : '');
  }
  if (document.getElementById('secEmpTableBody')) filterSectionTable();
  if (typeof renderAdminDashboard === 'function') renderAdminDashboard();
  if (typeof updateAdminResetDeptInfo === 'function') updateAdminResetDeptInfo();
}
window.resetDepartmentExams = resetDepartmentExams;

function updateAdminResetSecInfo() {
  const select = document.getElementById('adminResetSecSelect');
  const infoEl = document.getElementById('adminResetSecInfo');
  if (!select || !infoEl) return;

  const secId = select.value;
  const sec = QA_SECTIONS_LIST.find(s => s.id === secId) || QA_SECTIONS_LIST[0];
  const sectionEmps = EMPLOYEES.filter(e => normalizeSectionName(e.section || '') === sec.normName);
  const records = getStoredRecords();

  let completed = 0;
  sectionEmps.forEach(e => {
    if (records[e.empNo] && records[e.empNo].isCompleted) completed++;
  });

  infoEl.innerHTML = `<strong>Section:</strong> ${sec.title} &bull; <strong>Total Staff:</strong> ${sectionEmps.length} &bull; <strong>Completed:</strong> <span style="color: ${completed > 0 ? '#059669' : '#64748B'}; font-weight: 700;">${completed}</span> &bull; <strong>Not Started:</strong> ${sectionEmps.length - completed}`;
}
window.updateAdminResetSecInfo = updateAdminResetSecInfo;

function updateAdminResetDeptInfo() {
  const select = document.getElementById('adminResetDeptSelect');
  const infoEl = document.getElementById('adminResetDeptInfo');
  if (!select || !infoEl) return;

  const dept = select.value;
  const deptEmps = EMPLOYEES.filter(e => {
    const d = String(e.dept || 'QUALITY CONTROL').toUpperCase().trim();
    return d === dept.toUpperCase() || d.includes(dept.toUpperCase());
  });
  const records = getStoredRecords();

  let completed = 0;
  deptEmps.forEach(e => {
    if (records[e.empNo] && records[e.empNo].isCompleted) completed++;
  });

  infoEl.innerHTML = `<strong>Department:</strong> ${dept} &bull; <strong>Total Staff:</strong> ${deptEmps.length} &bull; <strong>Completed:</strong> <span style="color: ${completed > 0 ? '#059669' : '#64748B'}; font-weight: 700;">${completed}</span> &bull; <strong>Not Started:</strong> ${deptEmps.length - completed}`;
}
window.updateAdminResetDeptInfo = updateAdminResetDeptInfo;

function triggerAdminSecReset() {
  const select = document.getElementById('adminResetSecSelect');
  if (!select) return;
  const secId = select.value;
  const sec = QA_SECTIONS_LIST.find(s => s.id === secId);
  resetSectionExams(secId, sec ? sec.title : secId);
}
window.triggerAdminSecReset = triggerAdminSecReset;

function triggerAdminDeptReset() {
  const select = document.getElementById('adminResetDeptSelect');
  if (!select) return;
  resetDepartmentExams(select.value);
}
window.triggerAdminDeptReset = triggerAdminDeptReset;

function resetCurrentActiveSectionExams() {
  const secKey = typeof currentActiveSectionKey !== 'undefined' ? currentActiveSectionKey : 'warehouse';
  const sec = QA_SECTIONS_LIST.find(s => s.id === secKey);
  resetSectionExams(secKey, sec ? sec.title : currentActiveSection);
}
window.resetCurrentActiveSectionExams = resetCurrentActiveSectionExams;

function saveOjtRecord(empNo, data) {
  const all = getStoredOjtRecords();
  all[empNo] = { ...(all[empNo] || {}), ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY_OJT, JSON.stringify(all));

  try {
    fetch('/api/ojt-evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo, ojtData: all[empNo] })
    }).catch(() => {});
  } catch (e) {}
}

let activeOjtEmployee = null;
let activeOjtTemplate = null;
let activeOjtScores = {};
let activeOjtWiChecks = {};

function populateOjtTemplateSwitcher() {
  const switcher = document.getElementById('ojtTemplateSwitcher');
  if (!switcher || typeof OJT_OFFICIAL_TEMPLATES === 'undefined') return;
  const currentVal = (activeOjtTemplate && activeOjtTemplate.id) || switcher.value;
  switcher.innerHTML = '<option value="">-- Choose Official OJT Template --</option>';
  
  const templateOrder = ['86D', '84D', '83D', '89D', '90D', '85D', '87D', '88D', '90G'];
  templateOrder.forEach(id => {
    const tmpl = OJT_OFFICIAL_TEMPLATES[id];
    if (tmpl) {
      const opt = document.createElement('option');
      opt.value = tmpl.id;
      opt.textContent = `${tmpl.id} - ${tmpl.title.replace('TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION', '').replace('TN PLANT -', '').trim()} (${tmpl.checkpointCount} Checkpoints)`;
      switcher.appendChild(opt);
    }
  });
  if (currentVal && OJT_OFFICIAL_TEMPLATES[currentVal]) switcher.value = currentVal;
}

function switchOjtTemplate(templateId) {
  if (typeof OJT_OFFICIAL_TEMPLATES === 'undefined' || !OJT_OFFICIAL_TEMPLATES[templateId]) return;
  activeOjtTemplate = OJT_OFFICIAL_TEMPLATES[templateId];
  renderOjtForm();
}

function populateOjtEmployeeSwitcher() {
  const switcher = document.getElementById('ojtEmployeeSwitcher');
  if (!switcher) return;
  const currentVal = switcher.value;
  switcher.innerHTML = '<option value="">-- Choose Employee to Evaluate --</option>';
  if (typeof EMPLOYEES !== 'undefined' && Array.isArray(EMPLOYEES)) {
    const sorted = [...EMPLOYEES].sort((a, b) => {
      const secA = (a.section || '').localeCompare(b.section || '');
      if (secA !== 0) return secA;
      return String(a.empNo).localeCompare(String(b.empNo));
    });
    sorted.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.empNo;
      opt.textContent = `${emp.empNo} - ${emp.name} (${emp.section || emp.dept || 'QA'})`;
      switcher.appendChild(opt);
    });
  }
  if (currentVal) switcher.value = currentVal;
}

function hasOjtEvaluationAccess() {
  // 1. Admin login check
  try {
    const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
    if (sessionStr) {
      const session = JSON.parse(sessionStr);
      if (session && (session.role === 'admin' || session.username === 'admin')) {
        return true;
      }
    }
  } catch (e) {}

  // 2. Section portal login check
  if (sessionStorage.getItem('iluo_section_session')) {
    return true;
  }

  // 3. OJT 5-Section login check (Safety, CI & TPM, Quality, Technical, HR)
  if (sessionStorage.getItem('iluo_ojt_session')) {
    return true;
  }

  return false;
}

function openOjtModalQuick() {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Restricted: OJT practical evaluations can only be accessed by Section Supervisors and Admins.');
    navigateTo('/section');
    return;
  }

  populateOjtEmployeeSwitcher();
  populateOjtTemplateSwitcher();

  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  let session = null;
  try { session = sessionStr ? JSON.parse(sessionStr) : null; } catch (e) {}

  let targetEmpNo = (currentUser && currentUser.empNo) || 
                    (session && session.empNo) || 
                    window.lastCompletedEmpNo;

  if (!targetEmpNo) {
    const switcher = document.getElementById('ojtEmployeeSwitcher');
    if (switcher && switcher.value) {
      targetEmpNo = switcher.value;
    }
  }

  if (!targetEmpNo) {
    const records = getStoredRecords();
    const recKeys = Object.keys(records);
    if (recKeys.length > 0) {
      targetEmpNo = recKeys[recKeys.length - 1];
    }
  }

  if (!targetEmpNo && typeof EMPLOYEES !== 'undefined' && EMPLOYEES.length > 0) {
    targetEmpNo = EMPLOYEES[0].empNo;
  }

  if (targetEmpNo) {
    openOjtModalForEmployee(targetEmpNo);
  } else {
    const modal = document.getElementById('modalOjtEvaluation');
    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
      modal.scrollTop = 0;
    }
  }
}

function openOjtModalForCurrentEmployee() {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Restricted: Employees cannot access the OJT practical evaluation form.');
    return;
  }
  openOjtModalQuick();
}

function openOjtModalForEmployee(empNo, optTemplateId) {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Restricted: OJT practical evaluations can only be accessed and scored by Section Supervisors and Admins.');
    return;
  }

  // If templates script is still loading asynchronously, wait and retry
  if (typeof OJT_OFFICIAL_TEMPLATES === 'undefined') {
    setTimeout(() => openOjtModalForEmployee(empNo, optTemplateId), 150);
    return;
  }

  const emp = (typeof EMPLOYEES !== 'undefined' && Array.isArray(EMPLOYEES))
    ? EMPLOYEES.find(e => String(e.empNo).trim() === String(empNo).trim())
    : null;
  if (!emp) {
    showToast(`Employee ${empNo} not found in directory.`);
    return;
  }

  activeOjtEmployee = emp;

  if (optTemplateId && OJT_OFFICIAL_TEMPLATES[optTemplateId]) {
    activeOjtTemplate = OJT_OFFICIAL_TEMPLATES[optTemplateId];
  } else {
    activeOjtTemplate = getOjtTemplateForSection(emp.section);
  }
  if (!activeOjtTemplate && typeof OJT_OFFICIAL_TEMPLATES !== 'undefined') {
    activeOjtTemplate = OJT_OFFICIAL_TEMPLATES['87D'] || Object.values(OJT_OFFICIAL_TEMPLATES)[0];
  }

  populateOjtEmployeeSwitcher();
  populateOjtTemplateSwitcher();

  const empSwitcher = document.getElementById('ojtEmployeeSwitcher');
  if (empSwitcher) empSwitcher.value = emp.empNo;

  const tmplSwitcher = document.getElementById('ojtTemplateSwitcher');
  if (tmplSwitcher && activeOjtTemplate) tmplSwitcher.value = activeOjtTemplate.id;

  // Load existing saved evaluation if present
  const allOjt = getStoredOjtRecords();
  const existing = allOjt[empNo] || {};

  activeOjtScores = existing.scores ? { ...existing.scores } : {};
  activeOjtWiChecks = existing.wiChecks ? { ...existing.wiChecks } : {};

  const commEl = document.getElementById('ojtImprovementComments');
  if (commEl) commEl.value = existing.comments || '';

  const currentOjtRole = sessionStorage.getItem('iluo_ojt_session') || '';
  const safeEl = document.getElementById('ojtSafetyRep');
  if (safeEl) safeEl.value = existing.safetyRep || (currentOjtRole === 'Safety' ? 'R. SURENDRAN (Safety Officer)' : (existing.safetyRep || ''));
  const safeDateEl = document.getElementById('ojtSafetyDate');
  if (safeDateEl) safeDateEl.value = existing.safetyDate || new Date().toISOString().split('T')[0];

  const qualEl = document.getElementById('ojtQualityRep');
  if (qualEl) qualEl.value = existing.qualityRep || (currentOjtRole === 'Quality' ? 'M. RAMESH (QA Lead)' : (existing.qualityRep || ''));
  const qualDateEl = document.getElementById('ojtQualityDate');
  if (qualDateEl) qualDateEl.value = existing.qualityDate || new Date().toISOString().split('T')[0];

  const ciEl = document.getElementById('ojtCiRep');
  if (ciEl) ciEl.value = existing.ciRep || (currentOjtRole.includes('CI') ? 'K. ARUN (CI & TPM Specialist)' : (existing.ciRep || ''));
  const ciDateEl = document.getElementById('ojtCiDate');
  if (ciDateEl) ciDateEl.value = existing.ciDate || new Date().toISOString().split('T')[0];

  const techEl = document.getElementById('ojtTechRep');
  if (techEl) techEl.value = existing.techRep || (currentOjtRole === 'Technical' ? 'S. VIJAY (Technical Trainer)' : (existing.techRep || ''));
  const techDateEl = document.getElementById('ojtTechDate');
  if (techDateEl) techDateEl.value = existing.techDate || new Date().toISOString().split('T')[0];

  const hrEl = document.getElementById('ojtHrRep');
  if (hrEl) hrEl.value = existing.hrRep || (currentOjtRole === 'HR' ? 'D. ANITHA (HR & Competency Mgr)' : (existing.hrRep || ''));
  const hrDateEl = document.getElementById('ojtHrDate');
  if (hrDateEl) hrDateEl.value = existing.hrDate || new Date().toISOString().split('T')[0];

  const safeHeadEl = document.getElementById('ojtSafetyHeadSign');
  if (safeHeadEl) safeHeadEl.value = existing.safetyHeadSign || '';

  const qualHeadEl = document.getElementById('ojtQualityHeadSign');
  if (qualHeadEl) qualHeadEl.value = existing.qualityHeadSign || '';

  const ciHeadEl = document.getElementById('ojtCiHeadSign');
  if (ciHeadEl) ciHeadEl.value = existing.ciHeadSign || '';

  const reassessEl = document.getElementById('ojtReassessmentDate');
  if (reassessEl) reassessEl.value = existing.reassessmentDate || '';

  renderOjtForm();

  if (existing.qualificationStatus === 'Qualified') {
    const radioYes = document.getElementById('ojtQualRadioYes');
    if (radioYes) radioYes.checked = true;
    const radioNo = document.getElementById('ojtQualRadioNo');
    if (radioNo) radioNo.checked = false;
    const recEl = document.getElementById('ojtFinalRecommendationDisplay');
    if (recEl) { recEl.innerText = 'Approved (Qualified)'; recEl.style.color = '#166534'; }
  } else if (existing.qualificationStatus === 'Not Qualified') {
    const radioNo = document.getElementById('ojtQualRadioNo');
    if (radioNo) radioNo.checked = true;
    const radioYes = document.getElementById('ojtQualRadioYes');
    if (radioYes) radioYes.checked = false;
    const recEl = document.getElementById('ojtFinalRecommendationDisplay');
    if (recEl) { recEl.innerText = 'Reassessment Required (Not Qualified)'; recEl.style.color = '#B91C1C'; }
  }

  const modal = document.getElementById('modalOjtEvaluation');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('active');
    modal.scrollTop = 0;
  }
}

function renderOjtForm() {
  if (!activeOjtEmployee) return;
  if (!activeOjtTemplate && typeof OJT_OFFICIAL_TEMPLATES !== 'undefined') {
    activeOjtTemplate = getOjtTemplateForSection(activeOjtEmployee.section) || OJT_OFFICIAL_TEMPLATES['87D'] || Object.values(OJT_OFFICIAL_TEMPLATES)[0];
  }
  if (!activeOjtTemplate) return;

  const emp = activeOjtEmployee;
  const tmpl = activeOjtTemplate;

  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
  const currLvl = emp.currentLevel || 'I';
  const targetLvl = targetMap[currLvl] || 'L';

  const records = getStoredRecords();
  const rec = records[emp.empNo] || {};
  const assessmentDate = emp.assessmentDate || rec.attemptDate || new Date().toLocaleDateString('en-GB');

  const titleEl = document.getElementById('ojtModalHeaderTitle');
  if (titleEl) titleEl.innerText = tmpl.title;

  const fmtEl = document.getElementById('ojtModalFormatNo');
  if (fmtEl) fmtEl.innerText = tmpl.formatNo;

  const fmtFooterEl = document.getElementById('ojtModalFooterFormatNo');
  if (fmtFooterEl) fmtFooterEl.innerText = tmpl.formatNo;

  const nameEl = document.getElementById('ojtEmpName');
  if (nameEl) nameEl.innerText = emp.name;

  const noEl = document.getElementById('ojtEmpNo');
  if (noEl) noEl.innerText = emp.empNo;

  const secEl = document.getElementById('ojtEmpSection');
  if (secEl) secEl.innerText = `${emp.section} / ${emp.dept}`;

  const dojEl = document.getElementById('ojtEmpDoj');
  if (dojEl) dojEl.innerText = emp.doj || '-';

  const lvlEl = document.getElementById('ojtEmpSkillLevel');
  if (lvlEl) lvlEl.innerText = `( ${currLvl} )   TO   ( ${targetLvl} )`;

  const dateEl = document.getElementById('ojtAssessmentDate');
  if (dateEl) dateEl.innerText = assessmentDate;

  // Render Checkpoint Rows (Exact 10-column layout matching D:\OJT official sheets)
  const tbody = document.getElementById('ojtCheckpointsBody');
  if (tbody) {
    tbody.innerHTML = tmpl.checkpoints.map((cp, idx) => {
      const currentScore = activeOjtScores[cp.sno] || 0;
      const isWiChecked = !!activeOjtWiChecks[cp.sno];

      const buttonsHtml = [1, 2, 3, 4, 5].map(val => {
        const isActive = currentScore === val;
        return `
          <button type="button" 
                  class="ojt-score-btn score-${val} ${isActive ? 'active' : ''}" 
                  onclick="setOjtScore(${cp.sno}, ${val})"
                  title="Rank ${val}">
            ${val}
          </button>
        `;
      }).join('');

      return `
        <tr style="background: ${idx % 2 === 0 ? '#FFFFFF' : '#FAFAFA'};">
          <td style="border: 1px solid #000; padding: 6px 8px; text-align: center; font-weight: 700; color: #000000; width: 50px;">${cp.sno}</td>
          <td colspan="6" style="border: 1px solid #000; padding: 6px 12px; color: #000000; font-weight: 600; line-height: 1.35; font-size: 0.86rem;">${cp.text}</td>
          <td colspan="2" style="border: 1px solid #000; padding: 4px 6px; text-align: center; width: 170px;">
            <div class="ojt-score-group" style="display: inline-flex; gap: 4px; justify-content: center; align-items: center;">
              ${buttonsHtml}
            </div>
          </td>
          <td style="border: 1px solid #000; padding: 4px 6px; text-align: center; width: 85px;">
            <button type="button" 
                    id="ojtWiCheckBtn_${cp.sno}"
                    class="ojt-wicheck-btn ${isWiChecked ? 'active' : ''}" 
                    onclick="toggleOjtWiCheck(${cp.sno})"
                    style="font-size: 0.78rem; padding: 4px 8px;">
              ${isWiChecked ? '✓ OK' : 'Check'}
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  updateOjtTotals();
}

function closeOjtModal() {
  const modal = document.getElementById('modalOjtEvaluation');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function setOjtScore(sno, val) {
  activeOjtScores[sno] = val;

  const tbody = document.getElementById('ojtCheckpointsBody');
  if (tbody && activeOjtTemplate) {
    const rows = tbody.querySelectorAll('tr');
    activeOjtTemplate.checkpoints.forEach((cp, rIdx) => {
      if (cp.sno === sno && rows[rIdx]) {
        const btns = rows[rIdx].querySelectorAll('.ojt-score-btn');
        btns.forEach((btn, bIdx) => {
          if (bIdx + 1 === val) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      }
    });
  }

  updateOjtTotals();
}

function toggleOjtWiCheck(sno) {
  activeOjtWiChecks[sno] = !activeOjtWiChecks[sno];
  const btn = document.getElementById(`ojtWiCheckBtn_${sno}`);
  if (btn) {
    if (activeOjtWiChecks[sno]) {
      btn.classList.add('active');
      btn.innerText = '✓ OK';
    } else {
      btn.classList.remove('active');
      btn.innerText = 'Check';
    }
  }
}

function onOjtRadioChange(status) {
  const recEl = document.getElementById('ojtFinalRecommendationDisplay');
  if (recEl) {
    if (status === 'Qualified') {
      recEl.innerText = 'Approved (Qualified)';
      recEl.style.color = '#166534';
    } else {
      recEl.innerText = 'Reassessment Required (Not Qualified)';
      recEl.style.color = '#B91C1C';
    }
  }
}

function updateOjtTotals() {
  if (!activeOjtTemplate) return;

  const numCheckpoints = activeOjtTemplate.checkpointCount || activeOjtTemplate.checkpoints.length;
  const maxScore = numCheckpoints * 5;
  let totalScore = 0;
  let scoredCount = 0;

  activeOjtTemplate.checkpoints.forEach(cp => {
    const val = activeOjtScores[cp.sno];
    if (val && val > 0) {
      totalScore += val;
      scoredCount++;
    }
  });

  const pct = Math.round((totalScore / maxScore) * 100);
  const isQualified = pct >= 70;

  const totalDisplay = document.getElementById('ojtTotalScoreDisplay');
  if (totalDisplay) {
    totalDisplay.innerText = `${totalScore} / ${maxScore} = ${pct}%`;
  }

  const badge = document.getElementById('ojtQualificationBadge');
  const radioYes = document.getElementById('ojtQualRadioYes');
  const radioNo = document.getElementById('ojtQualRadioNo');
  const recEl = document.getElementById('ojtFinalRecommendationDisplay');

  if (badge) {
    if (scoredCount === 0) {
      badge.style.background = '#FEF3C7';
      badge.style.color = '#D97706';
      badge.innerText = 'PENDING';
      if (radioYes) radioYes.checked = false;
      if (radioNo) radioNo.checked = false;
      if (recEl) {
        recEl.innerText = 'Pending Evaluation';
        recEl.style.color = '#D97706';
      }
    } else if (isQualified) {
      badge.style.background = '#DCFCE7';
      badge.style.color = '#166534';
      badge.innerText = `QUALIFIED (${totalScore} / ${maxScore} = ${pct}%)`;
      if (radioYes) radioYes.checked = true;
      if (radioNo) radioNo.checked = false;
      if (recEl) {
        recEl.innerText = 'Approved (Qualified)';
        recEl.style.color = '#166534';
      }
    } else {
      badge.style.background = '#FEE2E2';
      badge.style.color = '#B91C1C';
      badge.innerText = `NOT QUALIFIED (${totalScore} / ${maxScore} = ${pct}%)`;
      if (radioYes) radioYes.checked = false;
      if (radioNo) radioNo.checked = true;
      if (recEl) {
        recEl.innerText = 'Reassessment Required (Not Qualified)';
        recEl.style.color = '#B91C1C';
      }
    }
  }
}

function saveOjtEvaluationForm() {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Denied: Only Section Supervisors and Admins can save OJT evaluations.');
    return;
  }
  if (!activeOjtEmployee || !activeOjtTemplate) return;

  const numCheckpoints = activeOjtTemplate.checkpointCount || activeOjtTemplate.checkpoints.length;
  const maxScore = numCheckpoints * 5;
  let totalScore = 0;
  activeOjtTemplate.checkpoints.forEach(cp => {
    totalScore += (activeOjtScores[cp.sno] || 0);
  });

  const pct = Math.round((totalScore / maxScore) * 100);
  const radioYes = document.getElementById('ojtQualRadioYes');
  const qualificationStatus = (radioYes && radioYes.checked) || (pct >= 70) ? 'Qualified' : 'Not Qualified';

  const ojtData = {
    empNo: activeOjtEmployee.empNo,
    name: activeOjtEmployee.name,
    section: activeOjtEmployee.section,
    templateId: activeOjtTemplate.id,
    templateCode: activeOjtTemplate.id,
    formatNo: activeOjtTemplate.formatNo,
    title: activeOjtTemplate.title,
    scores: { ...activeOjtScores },
    wiChecks: { ...activeOjtWiChecks },
    totalScore,
    maxScore,
    scorePct: pct,
    qualificationStatus,
    reassessmentDate: document.getElementById('ojtReassessmentDate') ? document.getElementById('ojtReassessmentDate').value : '',
    comments: document.getElementById('ojtImprovementComments') ? document.getElementById('ojtImprovementComments').value.trim() : '',
    safetyRep: document.getElementById('ojtSafetyRep') ? document.getElementById('ojtSafetyRep').value.trim() : '',
    safetyDate: document.getElementById('ojtSafetyDate') ? document.getElementById('ojtSafetyDate').value : '',
    qualityRep: document.getElementById('ojtQualityRep') ? document.getElementById('ojtQualityRep').value.trim() : '',
    qualityDate: document.getElementById('ojtQualityDate') ? document.getElementById('ojtQualityDate').value : '',
    ciRep: document.getElementById('ojtCiRep') ? document.getElementById('ojtCiRep').value.trim() : '',
    ciDate: document.getElementById('ojtCiDate') ? document.getElementById('ojtCiDate').value : '',
    techRep: document.getElementById('ojtTechRep') ? document.getElementById('ojtTechRep').value.trim() : '',
    techDate: document.getElementById('ojtTechDate') ? document.getElementById('ojtTechDate').value : '',
    hrRep: document.getElementById('ojtHrRep') ? document.getElementById('ojtHrRep').value.trim() : '',
    hrDate: document.getElementById('ojtHrDate') ? document.getElementById('ojtHrDate').value : '',
    safetyHeadSign: document.getElementById('ojtSafetyHeadSign') ? document.getElementById('ojtSafetyHeadSign').value.trim() : '',
    qualityHeadSign: document.getElementById('ojtQualityHeadSign') ? document.getElementById('ojtQualityHeadSign').value.trim() : '',
    ciHeadSign: document.getElementById('ojtCiHeadSign') ? document.getElementById('ojtCiHeadSign').value.trim() : '',
    evaluatedAt: new Date().toISOString().split('T')[0]
  };

  saveOjtRecord(activeOjtEmployee.empNo, ojtData);

  if (document.getElementById('adminTableBody')) {
    const searchInput = document.getElementById('adminSearchInput');
    renderAdminTable(searchInput ? searchInput.value : '');
  }

  if (document.getElementById('ojtTableBody')) {
    renderOjtDashboardTable();
  }

  showToast(`OJT Evaluation saved successfully for Employee ${activeOjtEmployee.empNo} (${qualificationStatus})`);
}

function downloadCurrentOjtExcel() {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Denied: Only Section Supervisors and Admins can download OJT Excel files.');
    return;
  }
  if (!activeOjtEmployee || !activeOjtTemplate) return;

  saveOjtEvaluationForm();

  const emp = activeOjtEmployee;
  const tmpl = activeOjtTemplate;
  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
  const currLvl = emp.currentLevel || 'I';
  const targetLvl = targetMap[currLvl] || 'L';

  const records = getStoredRecords();
  const rec = records[emp.empNo] || {};
  const assessmentDate = emp.assessmentDate || rec.attemptDate || new Date().toLocaleDateString('en-GB');

  const numCheckpoints = tmpl.checkpointCount || tmpl.checkpoints.length;
  const maxScore = numCheckpoints * 5;
  let totalScore = 0;
  tmpl.checkpoints.forEach(cp => {
    totalScore += (activeOjtScores[cp.sno] || 0);
  });
  const pct = Math.round((totalScore / maxScore) * 100);

  const comments = document.getElementById('ojtImprovementComments') ? document.getElementById('ojtImprovementComments').value.trim() : '';
  const safetyRep = document.getElementById('ojtSafetyRep') ? document.getElementById('ojtSafetyRep').value.trim() : '';
  const safetyDate = document.getElementById('ojtSafetyDate') ? document.getElementById('ojtSafetyDate').value : '';
  const qualityRep = document.getElementById('ojtQualityRep') ? document.getElementById('ojtQualityRep').value.trim() : '';
  const qualityDate = document.getElementById('ojtQualityDate') ? document.getElementById('ojtQualityDate').value : '';
  const ciRep = document.getElementById('ojtCiRep') ? document.getElementById('ojtCiRep').value.trim() : '';
  const ciDate = document.getElementById('ojtCiDate') ? document.getElementById('ojtCiDate').value : '';

  const radioYes = document.getElementById('ojtQualRadioYes');
  const isQual = (radioYes && radioYes.checked) || (pct >= 70);

  const cleanName = emp.name.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Yokohama_OJT_${tmpl.id}_${emp.empNo}_${cleanName}`;

  try {
    if (typeof XLSX !== 'undefined' && tmpl.base64) {
      // 100% BIT-FOR-BIT EXACT TEMPLATE FROM D:\OJT
      const wb = XLSX.read(tmpl.base64, { type: 'base64', cellStyles: true });
      const ws = wb.Sheets[wb.SheetNames[0]];

      // Populate Employee Details
      if (tmpl.nameCell) ws[tmpl.nameCell] = { t: 's', v: 'Name: ' + emp.name };
      if (tmpl.empIdCell) ws[tmpl.empIdCell] = { t: 's', v: 'Emp ID: ' + emp.empNo };
      if (tmpl.dojCell) ws[tmpl.dojCell] = { t: 's', v: 'Joining Date: ' + (emp.doj || '-') };
      if (tmpl.sectionDeptCell) ws[tmpl.sectionDeptCell] = { t: 's', v: 'Section & Dept.: ' + emp.section + ' / ' + emp.dept };
      if (tmpl.skillLevelCell) ws[tmpl.skillLevelCell] = { t: 's', v: 'Skill Level: ( ' + currLvl + ' )   TO   ( ' + targetLvl + ' )' };
      if (tmpl.assessmentDateCell) ws[tmpl.assessmentDateCell] = { t: 's', v: 'Assessment Date: ' + assessmentDate };

      // Populate Checkpoint Scores and WI Checks
      tmpl.checkpoints.forEach(cp => {
        const sc = activeOjtScores[cp.sno];
        if (sc !== undefined && sc > 0) {
          ws['H' + cp.row] = { t: 'n', v: sc };
        }
        if (activeOjtWiChecks[cp.sno]) {
          ws['J' + cp.row] = { t: 's', v: '✓' };
        }
      });

      // Total Score
      if (tmpl.totalScoreCell) {
        ws[tmpl.totalScoreCell] = { t: 's', v: `${totalScore}/${maxScore} = ${pct}%` };
      }

      // Improvement Comments
      if (tmpl.improvementCell && comments) {
        ws[tmpl.improvementCell] = { t: 's', v: comments };
      }

      // Evaluator Signatures
      if (tmpl.evalSafetyCell) {
        ws[tmpl.evalSafetyCell] = { t: 's', v: safetyRep ? (safetyRep + (safetyDate ? ' (' + safetyDate + ')' : '')) : '' };
      }
      if (tmpl.evalQualityCell) {
        ws[tmpl.evalQualityCell] = { t: 's', v: qualityRep ? (qualityRep + (qualityDate ? ' (' + qualityDate + ')' : '')) : '' };
      }
      if (tmpl.evalCiCell) {
        ws[tmpl.evalCiCell] = { t: 's', v: ciRep ? (ciRep + (ciDate ? ' (' + ciDate + ')' : '')) : '' };
      }

      // Section Head Signatures
      const safeHeadSign = document.getElementById('ojtSafetyHeadSign') ? document.getElementById('ojtSafetyHeadSign').value.trim() : '';
      const qualHeadSign = document.getElementById('ojtQualityHeadSign') ? document.getElementById('ojtQualityHeadSign').value.trim() : '';
      const ciHeadSign = document.getElementById('ojtCiHeadSign') ? document.getElementById('ojtCiHeadSign').value.trim() : '';
      const reassessDate = document.getElementById('ojtReassessmentDate') ? document.getElementById('ojtReassessmentDate').value : '';

      const baseHeadRow = tmpl.finalCommentRow ? (tmpl.finalCommentRow + 2) : (tmpl.totalScoreRow + 12);
      if (safeHeadSign) ws['A' + baseHeadRow] = { t: 's', v: safeHeadSign };
      if (qualHeadSign) ws['A' + (baseHeadRow + 2)] = { t: 's', v: qualHeadSign };
      if (ciHeadSign) ws['A' + (baseHeadRow + 4)] = { t: 's', v: ciHeadSign };
      if (reassessDate && tmpl.qualificationStatusRow) {
        ws['H' + tmpl.qualificationStatusRow] = { t: 's', v: reassessDate };
      }

      // Qualification Status
      if (isQual && tmpl.qualCellQualified) {
        ws[tmpl.qualCellQualified] = { t: 's', v: 'Qualified [✓]' };
      } else if (!isQual && tmpl.qualCellNotQualified) {
        ws[tmpl.qualCellNotQualified] = { t: 's', v: 'Not Qualified [✓]' };
      }

      XLSX.writeFile(wb, `${filename}.xlsx`);
      showToast(`Official OJT Excel (${tmpl.formatNo}) downloaded for Employee ${emp.empNo}!`);
    } else {
      // Fallback
      showToast('SheetJS XLSX library is initializing. Please try again.');
    }
  } catch (err) {
    console.error('OJT export error:', err);
    showToast('Download error: ' + err.message);
  }
}

async function downloadCurrentOjtDocx() {
  if (!hasOjtEvaluationAccess()) {
    showToast('Access Denied: Only Section Supervisors and Admins can download OJT Word files.');
    return;
  }
  if (!activeOjtEmployee || !activeOjtTemplate) return;

  saveOjtEvaluationForm();

  const emp = activeOjtEmployee;
  const tmpl = activeOjtTemplate;
  const allOjt = getStoredOjtRecords();
  const ojtData = allOjt[emp.empNo] || {};

  showToast(`Generating official OJT Word Document (${tmpl.id})...`);

  try {
    if (typeof window.YokohamaDocxGenerator !== 'undefined' && typeof window.JSZip !== 'undefined') {
      const zip = await window.YokohamaDocxGenerator.generateStandaloneOjtDocx(
        emp,
        tmpl,
        activeOjtScores,
        activeOjtWiChecks,
        ojtData,
        window.JSZip
      );

      const blob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

      const cleanName = emp.name.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `Yokohama_OJT_${tmpl.id}_${emp.empNo}_${cleanName}.docx`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      showToast(`Official OJT Word Document (${tmpl.formatNo}) downloaded successfully!`);
    } else {
      showToast('Word generator is initializing. Please try again in a moment.');
    }
  } catch (err) {
    console.error('OJT Word export error:', err);
    showToast('Download error: ' + err.message);
  }
}

// ---------------------------------------------------------------------
// 4-ROLE NAVIGATION & PORTAL SYSTEM (ui.pptx)
// ---------------------------------------------------------------------
function switchRolePortal(role) {
  if (role === 'home' || role === 'landing') {
    navigateTo('/');
    return;
  }

  // Update navbar buttons
  ['tabRoleHome', 'tabRoleEmp', 'tabRoleSection', 'tabRoleDept', 'tabRoleAdmin', 'tabRoleOjt'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active');
  });

  if (role === 'employee') {
    const btn = document.getElementById('tabRoleEmp');
    if (btn) btn.classList.add('active');
    if (currentUser) {
      navigateTo('/employee/dashboard');
    } else {
      navigateTo('/employee-portal');
    }
  } else if (role === 'section') {
    const btn = document.getElementById('tabRoleSection');
    if (btn) btn.classList.add('active');
    navigateTo('/section');
  } else if (role === 'department' || role === 'hod') {
    const btn = document.getElementById('tabRoleDept');
    if (btn) btn.classList.add('active');
    navigateTo('/department');
  } else if (role === 'admin') {
    const btn = document.getElementById('tabRoleAdmin');
    if (btn) btn.classList.add('active');
    const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
    const session = sessionStr ? JSON.parse(sessionStr) : null;
    if (session && session.role === 'admin') {
      navigateTo('/secure-control/dashboard');
    } else {
      navigateTo('/secure-control');
    }
  } else if (role === 'ojt' || role === 'ojt-login') {
    const btn = document.getElementById('tabRoleOjt');
    if (btn) btn.classList.add('active');
    navigateTo('/ojt-login');
  }
}

// ---------------------------------------------------------------------
// 5-SECTION OJT PORTAL LOGIC (Safety, CI & TPM, Quality, Technical, HR)
// ---------------------------------------------------------------------
function selectOjtLoginSection(secName) {
  const input = document.getElementById('ojtSelectedSectionInput');
  if (input) input.value = secName;

  const label = document.getElementById('ojtSelectedSectionLabel');
  const btnSubmit = document.getElementById('btnSubmitOjtLogin');

  const meta = {
    'Safety': { icon: '🦺', color: '#059669', title: 'Safety Section' },
    'CI & TPM': { icon: '⚙️', color: '#2563EB', title: 'CI & TPM Section' },
    'Quality': { icon: '🎯', color: '#DC2626', title: 'Quality Section' },
    'Technical': { icon: '🔧', color: '#7C3AED', title: 'Technical Section' },
    'HR': { icon: '👥', color: '#D97706', title: 'HR Section' }
  };
  const m = meta[secName] || { icon: '📋', color: '#059669', title: secName };

  if (label) {
    label.innerHTML = `${m.icon} ${m.title}`;
    label.style.color = m.color;
  }
  if (btnSubmit) {
    btnSubmit.innerText = `Sign In to ${secName} OJT Center`;
    btnSubmit.style.background = `linear-gradient(135deg, ${m.color} 0%, #003D6B 100%)`;
  }

  // Active state on buttons
  const mapBtn = {
    'Safety': 'ojtSecBtnSafety',
    'CI & TPM': 'ojtSecBtnCi',
    'Quality': 'ojtSecBtnQuality',
    'Technical': 'ojtSecBtnTechnical',
    'HR': 'ojtSecBtnHr'
  };
  Object.values(mapBtn).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  const activeBtn = document.getElementById(mapBtn[secName]);
  if (activeBtn) activeBtn.classList.add('active');
}

function handleOjtSectionLogin(e) {
  if (e) e.preventDefault();
  const secInput = document.getElementById('ojtSelectedSectionInput');
  const section = secInput ? secInput.value : 'Safety';
  const pwdInput = document.getElementById('ojtSectionPassword');
  const pwd = pwdInput ? pwdInput.value.trim().toLowerCase() : '';

  const validPasswords = {
    'Safety': ['safety123', 'ojt123'],
    'CI & TPM': ['ci123', 'cpm123', 'ojt123'],
    'Quality': ['quality123', 'ojt123'],
    'Technical': ['tech123', 'technical123', 'ojt123'],
    'HR': ['hr123', 'ojt123']
  };

  const allowed = validPasswords[section] || ['ojt123'];
  if (pwd && !allowed.includes(pwd)) {
    showToast(`Invalid password for ${section} Evaluator.`);
    return;
  }

  sessionStorage.setItem('iluo_ojt_session', section);

  const loginWrapper = document.getElementById('ojtLoginWrapper');
  const dashWrapper = document.getElementById('ojtDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'none';
  if (dashWrapper) dashWrapper.style.display = 'block';

  renderOjtDashboard(section);
  showToast(`Signed in as ${section} Evaluator`);
}

function quickEnterOjtSection(secName) {
  selectOjtLoginSection(secName);
  sessionStorage.setItem('iluo_ojt_session', secName);
  const loginWrapper = document.getElementById('ojtLoginWrapper');
  const dashWrapper = document.getElementById('ojtDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'none';
  if (dashWrapper) dashWrapper.style.display = 'block';
  renderOjtDashboard(secName);
  showToast(`Signed in to ${secName} OJT Center`);
}

function ojtLogout() {
  sessionStorage.removeItem('iluo_ojt_session');
  const loginWrapper = document.getElementById('ojtLoginWrapper');
  const dashWrapper = document.getElementById('ojtDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'block';
  if (dashWrapper) dashWrapper.style.display = 'none';
  showToast('Signed out of OJT Evaluation Center');
}

function renderOjtDashboard(secName) {
  const activeSec = secName || sessionStorage.getItem('iluo_ojt_session') || 'Safety';
  const meta = {
    'Safety': { icon: '🦺', color: '#059669', title: 'Safety Section OJT Center', badge: 'Safety Evaluator Active' },
    'CI & TPM': { icon: '⚙️', color: '#2563EB', title: 'CI & TPM Section OJT Center', badge: 'CI & TPM Evaluator Active' },
    'Quality': { icon: '🎯', color: '#DC2626', title: 'Quality Section OJT Center', badge: 'Quality Evaluator Active' },
    'Technical': { icon: '🔧', color: '#7C3AED', title: 'Technical Section OJT Center', badge: 'Technical Evaluator Active' },
    'HR': { icon: '👥', color: '#D97706', title: 'HR Section OJT Center', badge: 'HR Evaluator Active' }
  };
  const m = meta[activeSec] || meta['Safety'];

  const iconEl = document.getElementById('ojtActiveSectionIcon');
  if (iconEl) iconEl.innerText = m.icon;

  const titleEl = document.getElementById('ojtActiveSectionTitle');
  if (titleEl) titleEl.innerText = m.title;

  const badgeEl = document.getElementById('ojtActiveBadge');
  if (badgeEl) {
    badgeEl.innerText = m.badge;
    badgeEl.style.backgroundColor = m.color + '1A';
    badgeEl.style.color = m.color;
    badgeEl.style.border = `1px solid ${m.color}`;
  }

  // Update KPIs
  const allOjt = getStoredOjtRecords();
  const totalEmps = (typeof EMPLOYEES !== 'undefined') ? EMPLOYEES.length : 0;
  let qualifiedCount = 0;

  if (typeof EMPLOYEES !== 'undefined') {
    EMPLOYEES.forEach(emp => {
      const ojt = allOjt[emp.empNo];
      if (ojt && ojt.totalScore !== undefined) {
        const maxScore = ojt.maxScore || 50;
        if (ojt.totalScore >= Math.round(maxScore * 0.7)) {
          qualifiedCount++;
        }
      }
    });
  }

  const kpiTotal = document.getElementById('ojtKpiTotalEmps');
  if (kpiTotal) kpiTotal.innerText = totalEmps;

  const kpiQual = document.getElementById('ojtKpiQualified');
  if (kpiQual) kpiQual.innerText = qualifiedCount;

  const kpiPending = document.getElementById('ojtKpiPending');
  if (kpiPending) kpiPending.innerText = Math.max(0, totalEmps - qualifiedCount);

  renderOjtDashboardTable();
}

function renderOjtDashboardTable() {
  const tbody = document.getElementById('ojtTableBody');
  if (!tbody || typeof EMPLOYEES === 'undefined') return;

  const searchInput = document.getElementById('ojtEmpSearchInput');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const secFilter = document.getElementById('ojtQcSectionFilter');
  const selectedSec = secFilter ? secFilter.value : 'ALL';
  const lvlFilter = document.getElementById('ojtLevelFilter');
  const selectedLvl = lvlFilter ? lvlFilter.value : 'ALL';

  const allOjt = getStoredOjtRecords();
  const records = getStoredRecords();

  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };

  let filtered = EMPLOYEES.filter(emp => {
    if (query) {
      const matchName = (emp.name || '').toLowerCase().includes(query);
      const matchNo = String(emp.empNo || '').toLowerCase().includes(query);
      if (!matchName && !matchNo) return false;
    }
    if (selectedSec !== 'ALL') {
      const empSec = (emp.section || emp.dept || '').toLowerCase();
      if (!empSec.includes(selectedSec.toLowerCase())) return false;
    }
    if (selectedLvl !== 'ALL') {
      const currLvl = (emp.currentLevel || 'I').toUpperCase();
      const targetLvl = targetMap[currLvl] || 'L';
      if (selectedLvl === 'I') {
        if (currLvl !== 'I') return false;
      } else {
        if (targetLvl !== selectedLvl) return false;
      }
    }
    return true;
  });

  const countBadge = document.getElementById('ojtTableCounterBadge');
  if (countBadge) {
    countBadge.innerText = `Showing ${filtered.length} of ${EMPLOYEES.length} Employees`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 36px 20px; color: #94A3B8; font-size: 0.95rem;">No employees match the selected search or filter criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((emp, idx) => {
    const ojt = allOjt[emp.empNo];
    const rec = records[emp.empNo];
    const currLvl = emp.currentLevel || 'I';
    const targetLvl = targetMap[currLvl] || 'L';

    // Knowledge MCQ status
    let mcqText = `<span style="color: #94A3B8; font-size: 0.82rem; font-weight: 500;">Not Attempted</span>`;
    const examScore = rec ? (rec.totalMark !== undefined ? rec.totalMark : (rec.score !== undefined ? rec.score : (rec.submittedQuestions ? rec.submittedQuestions.filter(q => q.isCorrect).length : undefined))) : undefined;
    if (rec && (rec.isCompleted || examScore !== undefined)) {
      const qCount = (rec.submittedQuestions && rec.submittedQuestions.length) || (targetLvl === 'L' ? 20 : (targetLvl === 'U' ? 30 : 40));
      const mcqPassed = rec.status === 'Passed' || (examScore !== undefined && examScore >= Math.ceil(qCount * 0.7));
      mcqText = `<span class="${mcqPassed ? 'badge-pass' : 'badge-fail'}" style="font-size: 0.8rem; padding: 4px 10px; border-radius: 6px; display: inline-block;">${examScore !== undefined ? examScore : 0} / ${qCount} Marks (${mcqPassed ? 'PASS' : 'FAIL'})</span>`;
    }

    // Practical OJT Mark & Status
    let ojtMarkText = `<span style="color: #94A3B8; font-size: 0.82rem; font-weight: 500;">Pending</span>`;
    let statusBadge = `<span class="badge-pending" style="font-size: 0.8rem; padding: 4px 10px; border-radius: 6px; background: #FEF3C7; color: #D97706; font-weight: 700; display: inline-block;">PENDING</span>`;

    if (ojt && ojt.totalScore !== undefined) {
      const maxScore = ojt.maxScore || 50;
      const isQualified = ojt.totalScore >= Math.round(maxScore * 0.7);
      ojtMarkText = `<strong style="color: ${isQualified ? '#059669' : '#DC2626'}; font-size: 0.95rem;">${ojt.totalScore} / ${maxScore} Marks</strong>`;
      if (isQualified) {
        statusBadge = `<span class="badge-pass" style="font-size: 0.8rem; padding: 4px 10px; border-radius: 6px; display: inline-block;">QUALIFIED</span>`;
      } else {
        statusBadge = `<span class="badge-fail" style="font-size: 0.8rem; padding: 4px 10px; border-radius: 6px; display: inline-block;">NEEDS REFOCUS</span>`;
      }
    }

    return `
      <tr style="border-bottom: 1px solid #E2E8F0; transition: background 0.15s ease;">
        <td style="text-align: center; color: #64748B; font-weight: 600; padding: 14px 12px;">${idx + 1}</td>
        <td style="padding: 14px 16px;"><strong style="color: var(--primary-dark); font-size: 0.95rem;">${emp.empNo}</strong></td>
        <td style="padding: 14px 20px;"><strong style="color: #0F172A; font-size: 0.95rem;">${emp.name}</strong></td>
        <td style="padding: 14px 18px;"><span style="font-size: 0.88rem; color: #334155; font-weight: 500; white-space: nowrap;">${emp.section || emp.dept || 'QA'}</span></td>
        <td style="text-align: center; padding: 14px 12px;"><span class="iluo-badge iluo-badge-${currLvl.toLowerCase()}" style="width: 26px; height: 26px; font-size: 0.8rem;">${currLvl}</span></td>
        <td style="text-align: center; padding: 14px 12px;"><span class="iluo-badge iluo-badge-${targetLvl.toLowerCase()}" style="width: 26px; height: 26px; font-size: 0.8rem;">${targetLvl}</span></td>
        <td style="padding: 14px 18px;">${mcqText}</td>
        <td style="padding: 14px 18px;">${ojtMarkText}</td>
        <td style="padding: 14px 18px;">${statusBadge}</td>
        <td style="text-align: center; padding: 14px 18px;">
          <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
            <button type="button" class="btn-primary" style="padding: 6px 12px; font-size: 0.78rem; background: #059669; border-color: #059669; font-weight: 700; white-space: nowrap; border-radius: 6px; box-shadow: 0 2px 4px rgba(5,150,105,0.2); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="openOjtModalForEmployee('${emp.empNo}')">
              📋 OJT
            </button>
            <button type="button" class="btn-primary" style="padding: 6px 12px; font-size: 0.78rem; background: #1E3A8A; border-color: #1E3A8A; font-weight: 700; white-space: nowrap; border-radius: 6px; box-shadow: 0 2px 4px rgba(30,58,138,0.2); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">
              📄 DOCX
            </button>
            <button type="button" class="btn-primary" style="padding: 6px 12px; font-size: 0.78rem; background: #DC2626; border-color: #DC2626; font-weight: 700; white-space: nowrap; border-radius: 6px; box-shadow: 0 2px 4px rgba(220,38,38,0.2); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download Official PDF Report">
              📑 PDF
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Section Portal Logic
function handleSectionLogin(e) {
  if (e) e.preventDefault();
  const select = document.getElementById('secSelectInput');
  const secName = select ? select.value : 'Tire building QA';
  currentActiveSection = secName;
  sessionStorage.setItem('iluo_section_session', secName);
  
  const loginWrapper = document.getElementById('sectionLoginWrapper');
  const dashWrapper = document.getElementById('sectionDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'none';
  if (dashWrapper) dashWrapper.style.display = 'block';

  renderSectionDashboard(secName);
  showToast(`Welcome to ${secName} Portal`);
}

function switchSectionView(secName) {
  currentActiveSection = secName;
  sessionStorage.setItem('iluo_section_session', secName);
  renderSectionDashboard(secName);
}

function logoutSection() {
  sessionStorage.removeItem('iluo_section_session');
  const loginWrapper = document.getElementById('sectionLoginWrapper');
  const dashWrapper = document.getElementById('sectionDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'block';
  if (dashWrapper) dashWrapper.style.display = 'none';
}

function renderSectionDashboard(secName) {
  const title = document.getElementById('secDashboardTitle');
  if (title) title.innerText = secName;
  const switchDropdown = document.getElementById('secSwitchDropdown');
  if (switchDropdown) switchDropdown.value = secName;

  // Filter employees for this section
  const secNorm = secName.toLowerCase().replace(/\s+/g, ' ').trim();
  const emps = EMPLOYEES.filter(e => {
    const s = (e.section || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return s.includes(secNorm) || secNorm.includes(s);
  });

  // Count ILUO distribution
  let countI = 0, countL = 0, countU = 0, countO = 0;
  emps.forEach(e => {
    const lvl = (e.currentLevel || 'L').toUpperCase();
    if (lvl === 'I') countI++;
    else if (lvl === 'L') countL++;
    else if (lvl === 'U') countU++;
    else if (lvl === 'O') countO++;
  });

  const elI = document.getElementById('secCountI');
  if (elI) elI.innerText = countI;
  const elL = document.getElementById('secCountL');
  if (elL) elL.innerText = countL;
  const elU = document.getElementById('secCountU');
  if (elU) elU.innerText = countU;
  const elO = document.getElementById('secCountO');
  if (elO) elO.innerText = countO;

  renderSectionEmployeesTable(emps);
  renderSectionTrainingRequirements(emps);
}

function renderSectionEmployeesTable(emps) {
  const tbody = document.getElementById('secEmpTableBody');
  if (!tbody) return;

  const records = getStoredRecords();
  const ojtRecords = (typeof getStoredOjtRecords === 'function') ? getStoredOjtRecords() : {};

  if (!emps || emps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">No employees found in this section.</td></tr>`;
    return;
  }

  let html = '';
  emps.forEach(e => {
    const curLvl = (e.currentLevel || 'L').toUpperCase();
    const curRules = LEVEL_RULES[curLvl] || LEVEL_RULES['L'];
    const tgtLvl = (curRules && curRules.nextLevel) ? curRules.nextLevel : (curLvl === 'L' ? 'U' : 'O');

    const rec = records[e.empNo];
    const ojt = ojtRecords[e.empNo];

    // Knowledge marks & status
    let knowText = '<span style="color: #64748B; font-size: 0.82rem; font-weight: 500;">Pending</span>';
    let isKnowPass = false;
    if (rec && rec.isCompleted) {
      const qCount = rec.submittedQuestions ? rec.submittedQuestions.length : 20;
      const marks = rec.totalMark !== undefined ? rec.totalMark : (rec.submittedQuestions ? rec.submittedQuestions.filter(q => q.isCorrect).length : 0);
      isKnowPass = rec.status === 'Passed' || marks >= Math.ceil(qCount * 0.7);
      knowText = `<span style="font-weight: 700; color: ${isKnowPass ? '#059669' : '#DC2626'}; font-size: 0.88rem; white-space: nowrap;">${marks} / ${qCount} Marks</span>`;
    }

    // OJT marks & status
    let ojtText = '<span style="color: #64748B; font-size: 0.82rem; font-weight: 500;">Pending</span>';
    let isOjtPass = false;
    if (ojt && ojt.totalScore !== undefined) {
      const maxScore = ojt.maxScore || 50;
      isOjtPass = ojt.totalScore >= Math.round(maxScore * 0.7);
      ojtText = `<span style="font-weight: 700; color: ${isOjtPass ? '#059669' : '#DC2626'}; font-size: 0.88rem; white-space: nowrap;">${ojt.totalScore} / ${maxScore} Marks</span>`;
    } else if (ojt && ojt.isCompleted) {
      isOjtPass = true;
      ojtText = `<span style="font-weight: 700; color: #059669; font-size: 0.88rem; white-space: nowrap;">${ojt.totalScore || 0} / ${ojt.totalPossibleMarks || 20} Marks</span>`;
    }

    // Overall Status
    let overallStatus = '<span style="background: #F1F5F9; color: #64748B; padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 0.8rem; display: inline-block; white-space: nowrap;">Pending</span>';
    if (isKnowPass && isOjtPass) {
      overallStatus = `<span style="background: #ECFDF5; color: #166534; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 0.8rem; display: inline-block; white-space: nowrap;">Qualified (${tgtLvl})</span>`;
    } else if (rec && rec.isCompleted && !isKnowPass) {
      overallStatus = `<span style="background: #FEF2F2; color: #DC2626; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 0.8rem; display: inline-block; white-space: nowrap;">Retest Req.</span>`;
    }

    html += `
      <tr style="border-bottom: 1px solid #E2E8F0; transition: background 0.15s ease;">
        <td style="font-weight: 700; color: var(--primary-dark); padding: 14px 16px; font-size: 0.95rem;">${e.empNo}</td>
        <td style="padding: 14px 20px;"><strong style="color: #0F172A; font-size: 0.95rem;">${e.name}</strong></td>
        <td style="text-align: center; padding: 14px 12px;"><span class="iluo-badge iluo-badge-${curLvl.toLowerCase()}" style="width: 26px; height: 26px; font-size: 0.8rem;">${curLvl}</span></td>
        <td style="text-align: center; padding: 14px 12px;"><strong style="color: var(--accent-red); font-size: 0.95rem;">${tgtLvl}</strong></td>
        <td style="padding: 14px 18px;">${knowText}</td>
        <td style="padding: 14px 18px;">${ojtText}</td>
        <td style="padding: 14px 18px;">${overallStatus}</td>
        <td style="padding: 14px 18px; text-align: center;">
          <div style="display: flex; gap: 8px; justify-content: center; align-items: center;">
            <button class="btn-sm" style="background: #059669; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(5,150,105,0.2);" onclick="openOjtModalForEmployee('${e.empNo}')" title="Score OJT Evaluation Form">📋 OJT</button>
            <button class="btn-sm" style="background: #005B9E; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(0,91,158,0.2);" onclick="downloadEmployeeDocx('${e.empNo}')" title="Download Official DOCX Report">📄 DOCX</button>
            <button class="btn-sm" style="background: #DC2626; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 0.78rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(220,38,38,0.2);" onclick="downloadEmployeePDF('${e.empNo}')" title="Download Official PDF Report">📑 PDF</button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function filterSectionTable() {
  const search = (document.getElementById('secEmpSearchInput')?.value || '').toLowerCase().trim();
  const lvl = document.getElementById('secLevelFilter')?.value || 'ALL';
  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };

  const secNorm = currentActiveSection.toLowerCase().replace(/\s+/g, ' ').trim();
  const emps = EMPLOYEES.filter(e => {
    const s = (e.section || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s.includes(secNorm) && !secNorm.includes(s)) return false;
    if (lvl !== 'ALL') {
      const curLvl = (e.currentLevel || 'I').toUpperCase();
      const tgtLvl = targetMap[curLvl] || 'L';
      if (lvl === 'I') {
        if (curLvl !== 'I') return false;
      } else {
        if (tgtLvl !== lvl) return false;
      }
    }
    if (search && !e.name.toLowerCase().includes(search) && !String(e.empNo).toLowerCase().includes(search)) return false;
    return true;
  });

  renderSectionEmployeesTable(emps);
}

function renderSectionTrainingRequirements(emps) {
  const container = document.getElementById('secTrainingReqContainer');
  if (!container) return;

  const records = getStoredRecords();
  const ojtRecords = (typeof getStoredOjtRecords === 'function') ? getStoredOjtRecords() : {};

  const trainingReqs = [];
  emps.forEach(e => {
    const curLvl = (e.currentLevel || 'L').toUpperCase();
    const rec = records[e.empNo];
    const ojt = ojtRecords[e.empNo];

    if (!rec || !rec.isCompleted) {
      trainingReqs.push({ emp: e, reason: 'Pending Knowledge Assessment', priority: 'High' });
    } else if (rec.totalMark !== undefined && rec.totalMark < 14) {
      trainingReqs.push({ emp: e, reason: 'Retest Required: Knowledge score below pass benchmark', priority: 'Urgent' });
    } else if (!ojt || !ojt.isCompleted) {
      trainingReqs.push({ emp: e, reason: 'Pending Practical OJT Evaluation', priority: 'Medium' });
    } else if (curLvl === 'I' || curLvl === 'L') {
      trainingReqs.push({ emp: e, reason: `Ready for Skill Up-gradation to Level ${curLvl === 'I' ? 'L' : 'U'}`, priority: 'Normal' });
    }
  });

  if (trainingReqs.length === 0) {
    container.innerHTML = `<div style="font-size: 0.88rem; color: #059669; font-weight: 600;">✔ All employees in this section are currently up to date on evaluations and qualifications!</div>`;
    return;
  }

  let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
  trainingReqs.forEach(t => {
    const badgeColor = t.priority === 'Urgent' ? '#DC2626' : (t.priority === 'High' ? '#D97706' : '#0284C7');
    html += `
      <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-radius: 6px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div>
          <strong style="color: var(--primary-dark);">${t.emp.name} (${t.emp.empNo})</strong>
          <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;">Current: Level ${t.emp.currentLevel || 'L'}</span>
          <div style="font-size: 0.8rem; color: #475569; margin-top: 2px;">${t.reason}</div>
        </div>
        <span style="background: ${badgeColor}15; color: ${badgeColor}; font-weight: 700; font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; border: 1px solid ${badgeColor}40;">${t.priority} Priority</span>
      </div>
    `;
  });
  html += '</div>';

  container.innerHTML = html;
}

// Department / HOD Portal Logic
function handleDeptLogin(e) {
  if (e) e.preventDefault();
  sessionStorage.setItem('iluo_dept_session', 'QUALITY CONTROL');
  
  const loginWrapper = document.getElementById('deptLoginWrapper');
  const dashWrapper = document.getElementById('deptDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'none';
  if (dashWrapper) dashWrapper.style.display = 'block';

  renderDepartmentDashboard();
  showToast('Welcome to Department / HOD Dashboard');
}

function logoutDept() {
  sessionStorage.removeItem('iluo_dept_session');
  const loginWrapper = document.getElementById('deptLoginWrapper');
  const dashWrapper = document.getElementById('deptDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'block';
  if (dashWrapper) dashWrapper.style.display = 'none';
}

function renderDepartmentDashboard() {
  const sectionsList = [
    'Tire building QA',
    'Final Finish QA',
    'Final Finish RRO & ALT QA',
    'Tire curing QA',
    'Solid tire QA',
    'Preparatory QA',
    'Warehouse QA',
    'FID inspector QA'
  ];

  // Calculate department totals
  let totalStaff = EMPLOYEES.length;
  let countI = 0, countL = 0, countU = 0, countO = 0;
  EMPLOYEES.forEach(e => {
    const lvl = (e.currentLevel || 'L').toUpperCase();
    if (lvl === 'I') countI++;
    else if (lvl === 'L') countL++;
    else if (lvl === 'U') countU++;
    else if (lvl === 'O') countO++;
  });

  const elStaff = document.getElementById('deptTotalStaff');
  if (elStaff) elStaff.innerText = totalStaff;
  const elI = document.getElementById('deptCountI');
  if (elI) elI.innerText = countI;
  const elL = document.getElementById('deptCountL');
  if (elL) elL.innerText = countL;
  const elU = document.getElementById('deptCountU');
  if (elU) elU.innerText = countU;
  const elO = document.getElementById('deptCountO');
  if (elO) elO.innerText = countO;

  // Render Section-Wise Summary Table
  const tbody = document.getElementById('deptSectionTableBody');
  if (!tbody) return;

  const records = getStoredRecords();
  const ojtRecords = (typeof getStoredOjtRecords === 'function') ? getStoredOjtRecords() : {};

  let rowsHtml = '';
  sectionsList.forEach(sec => {
    const secNorm = sec.toLowerCase().replace(/\s+/g, ' ').trim();
    const secEmps = EMPLOYEES.filter(e => {
      const s = (e.section || '').toLowerCase().replace(/\s+/g, ' ').trim();
      return s.includes(secNorm) || secNorm.includes(s);
    });

    let sI = 0, sL = 0, sU = 0, sO = 0;
    let sKnowDone = 0, sOjtDone = 0, sTrainNeeded = 0;

    secEmps.forEach(e => {
      const lvl = (e.currentLevel || 'L').toUpperCase();
      if (lvl === 'I') sI++;
      else if (lvl === 'L') sL++;
      else if (lvl === 'U') sU++;
      else if (lvl === 'O') sO++;

      const rec = records[e.empNo];
      const ojt = ojtRecords[e.empNo];

      if (rec && rec.isCompleted) sKnowDone++;
      if (ojt && ojt.isCompleted) sOjtDone++;
      if (!rec || !rec.isCompleted || (rec.totalMark !== undefined && rec.totalMark < 14) || !ojt || !ojt.isCompleted) {
        sTrainNeeded++;
      }
    });

    rowsHtml += `
      <tr>
        <td><strong style="color: var(--primary-dark);">${sec}</strong></td>
        <td><strong>${secEmps.length}</strong></td>
        <td><span class="iluo-badge iluo-badge-i" style="width: 22px; height: 22px; font-size: 0.72rem;">${sI}</span></td>
        <td><span class="iluo-badge iluo-badge-l" style="width: 22px; height: 22px; font-size: 0.72rem;">${sL}</span></td>
        <td><span class="iluo-badge iluo-badge-u" style="width: 22px; height: 22px; font-size: 0.72rem;">${sU}</span></td>
        <td><span class="iluo-badge iluo-badge-o" style="width: 22px; height: 22px; font-size: 0.72rem;">${sO}</span></td>
        <td><span style="color: #059669; font-weight: 700;">${sKnowDone} / ${secEmps.length}</span></td>
        <td><span style="color: #0284C7; font-weight: 700;">${sOjtDone} / ${secEmps.length}</span></td>
        <td><span style="color: ${sTrainNeeded > 0 ? '#DC2626' : '#059669'}; font-weight: 700;">${sTrainNeeded}</span></td>
        <td>
          <button class="btn-sm" style="background: #005B9E; color: white; border: none; padding: 4px 10px; border-radius: 4px; font-weight: 600; font-size: 0.75rem; cursor: pointer;" onclick="jumpToSectionView('${sec}')">
            View &raquo;
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;

  // Department Training Plan / Skill Gap summary
  const planContainer = document.getElementById('deptTrainingPlanContainer');
  if (planContainer) {
    planContainer.innerHTML = `
      <div style="font-size: 0.88rem; color: #475569; line-height: 1.6;">
        <p><strong>Department Training Priorities:</strong></p>
        <ul style="padding-left: 20px; margin-top: 6px;">
          <li><strong>Level I to L Transition:</strong> Focus on ${countI} beginner associates in Tire Building QA &amp; Preparatory QA for induction completion.</li>
          <li><strong>Level L to U Promotion:</strong> Accelerate practical OJT checkpoints for ${countL} learners across all 8 QA sections.</li>
          <li><strong>Target ILUO Ratio:</strong> Target distribution is 10% I, 30% L, 40% U, and 20% O across Yokohama ATC Tires plant operations.</li>
        </ul>
      </div>
    `;
  }
}

function jumpToSectionView(secName) {
  switchRolePortal('section');
  sessionStorage.setItem('iluo_section_session', secName);
  const loginWrapper = document.getElementById('sectionLoginWrapper');
  const dashWrapper = document.getElementById('sectionDashboardWrapper');
  if (loginWrapper) loginWrapper.style.display = 'none';
  if (dashWrapper) dashWrapper.style.display = 'block';
  renderSectionDashboard(secName);
}

// SOP Modal
function openSopModal() {
  const modal = document.getElementById('modalIluoStandards');
  if (modal) modal.style.display = 'flex';
}

function closeSopModal() {
  const modal = document.getElementById('modalIluoStandards');
  if (modal) modal.style.display = 'none';
}
