// Yokohama ILUO MCQ Assessment Application Logic & Router

// LocalStorage Keys
const STORAGE_KEY_RECORDS = 'iluo_assessment_records_v1';
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

// Initialize App & Router
document.addEventListener('DOMContentLoaded', () => {
  initStorage();
  initSecurityMonitors();
  window.addEventListener('hashchange', handleRoute);
  checkExistingSession();
});

function initStorage() {
  if (!localStorage.getItem(STORAGE_KEY_RECORDS)) {
    localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify({}));
  }
  // Immediate localStorage bootstrap for questions & employees
  try {
    const cachedQ = localStorage.getItem(STORAGE_KEY_CUSTOM_QUESTIONS);
    if (cachedQ) {
      const parsedQ = JSON.parse(cachedQ);
      ['L', 'U', 'O'].forEach(lvl => {
        if (parsedQ[lvl] && Array.isArray(parsedQ[lvl]) && parsedQ[lvl].length > 0) {
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

  syncCloudRecords();
  syncCloudOjtEvaluations();
  syncCloudQuestions();
  syncCloudEmployees();
  syncCloudSettings();
}

function getStoredRecords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECORDS)) || {};
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
    fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo, recordData })
    }).catch(err => console.log('Server sync pending:', err.message));
  } catch (e) {}
}

async function syncCloudRecords() {
  try {
    const res = await fetch('/api/records');
    const data = await res.json();
    if (data.success && data.records) {
      const local = getStoredRecords();
      const merged = { ...local, ...data.records };
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(merged));
      // Re-render admin table if visible
      if (document.getElementById('adminTableBody')) {
        const searchInput = document.getElementById('adminSearchInput');
        renderAdminTable(searchInput ? searchInput.value : '');
      }
    }
  } catch (e) {}
}

async function syncCloudOjtEvaluations() {
  try {
    const res = await fetch('/api/ojt-evaluations');
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
    const res = await fetch('/api/questions');
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

// ---------------------------------------------------------------------
// URL ROUTER ENGINE (/employee/* and /control-center/*)
// ---------------------------------------------------------------------
function navigateTo(path) {
  window.location.hash = path;
}

function handleRoute() {
  const rawHash = window.location.hash.slice(1);
  const hash = rawHash || '/';
  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  const session = sessionStr ? JSON.parse(sessionStr) : null;

  // Root Public Website Landing Page (/)
  if (hash === '/' || hash === '' || hash === '/public') {
    showView('viewPublicLanding');
    updateUserBadge(session && session.name ? session.name : (session && session.role === 'admin' ? 'Administrator' : null));
    return;
  }

  // Direct OJT Practical Evaluation Modal Route (/ojt, /ojt-evaluation, /ojt-form)
  if (hash === '/ojt' || hash === '/ojt-evaluation' || hash === '/ojt-form') {
    showView('viewPublicLanding');
    openOjtModalQuick();
    return;
  }

  // Explicit Employee Login Page (/employee-portal)
  if (hash === '/employee-portal' || hash === '/employee/login') {
    showView('viewEmpLogin');
 document.getElementById('btnSwitchPortal').innerText = 'Admin Portal';
 document.getElementById('navbarSystemTitle').innerText = 'Tire Building QA Assessment Portal';
    return;
  }

  // Explicit Admin Login Page (/secure-control)
  if (hash === '/secure-control' || hash === '/admin-login' || hash === '/admin') {
    showView('viewAdminLogin');
 document.getElementById('btnSwitchPortal').innerText = 'Employee Portal';
 document.getElementById('navbarSystemTitle').innerText = 'Admin Control Center';
    return;
  }

  // Protect Admin routes (/control-center/* and /secure-control/* subviews)
  if (hash.startsWith('/control-center') || hash.startsWith('/secure-control/')) {
    if (!session || session.role !== 'admin') {
      navigateTo('/secure-control');
      return;
    }
 document.getElementById('btnSwitchPortal').innerText = 'Employee Portal';
 document.getElementById('navbarSystemTitle').innerText = 'Admin Control Center';
    updateUserBadge(session.name || 'Administrator');
    
    let sub = hash.replace(/^\/(control-center|secure-control)\/?/, '').trim();
    if (!sub) sub = 'dashboard';
    showControlCenterSubView(sub);
    return;
  }

  // Protect Employee routes (/employee/*)
  if (hash.startsWith('/employee/')) {
    if (!session || session.role !== 'emp') {
      navigateTo('/employee-portal');
      return;
    }
 document.getElementById('btnSwitchPortal').innerText = 'Admin Portal';
 document.getElementById('navbarSystemTitle').innerText = 'Tire Building QA Assessment Portal';
    
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
// SECURITY MONITORS: Copy-Paste Restriction & Tab Switch Detection (Max 3)
// ---------------------------------------------------------------------
function initSecurityMonitors() {
  // Prevent Copy, Cut, Paste, Right Click
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

  // Tab Switcher / Focus Loss Monitor
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

    if (activeExam.tabSwitchCount <= 3) {
      showSecurityWarningModal(activeExam.tabSwitchCount);
    } else {
      terminateExamOnViolation('Exceeded 3 Tab Switches Limit');
    }
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
 countDisplay.innerText = `${count} / 3`;

  if (count > 0) {
    badgeContainer.classList.add('danger');
  } else {
    badgeContainer.classList.remove('danger');
  }
}

function showSecurityWarningModal(count) {
  const modal = document.getElementById('securityWarningModal');
 document.getElementById('secWarningNum').innerText = count;
  modal.classList.add('active');
}

function closeSecurityWarningModal() {
  document.getElementById('securityWarningModal').classList.remove('active');
}

function terminateExamOnViolation(reason) {
  if (timerInterval) clearInterval(timerInterval);
  if (!activeExam) return;

  activeExam.isCompleted = true;
  closeSecurityWarningModal();

  const questions = activeExam.questions;
  const responses = activeExam.responses;
  let correctCount = 0;

  questions.forEach(q => {
    if (responses[q.id] && responses[q.id] === q.correctAnswer) {
      correctCount++;
    }
  });

  const totalQs = questions.length;
  const markPct = Math.round((correctCount / totalQs) * 100);

  let uMark = 0, lMark = 0, oMark = 0;
  if (activeExam.targetLevel === 'U') uMark = correctCount;
  else if (activeExam.targetLevel === 'L') lMark = correctCount;
  else if (activeExam.targetLevel === 'O') oMark = correctCount;

  const recordData = {
    empNo: currentUser.empNo,
    name: currentUser.name,
    dept: currentUser.dept,
    section: currentUser.section,
    doj: currentUser.doj,
    targetLevel: activeExam.targetLevel,
    inProgress: false,
    isCompleted: true,
    tabSwitchCount: activeExam.tabSwitchCount,
    responses: responses,
    attemptedCount: Object.keys(responses).length,
    uMark: uMark,
    lMark: lMark,
    oMark: oMark,
    totalMark: correctCount,
    markPct: markPct,
    status: `Terminated (${reason})`,
    attemptDate: new Date().toLocaleDateString('en-GB')
  };

  saveRecord(currentUser.empNo, recordData);
  showResultView(recordData);
}

// ---------------------------------------------------------------------
// Session & Navigation Check
// ---------------------------------------------------------------------
async function checkExistingSession() {
  try {
    const res = await fetch('/api/auth/admin/session');
    const data = await res.json();
    if (data.authenticated && data.admin) {
      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({ role: 'admin', email: data.admin.email, name: data.admin.name }));
      updateUserBadge(data.admin.name);
      handleRoute();
      return;
    }
  } catch (e) {
    console.error('Session check error:', e);
  }

  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  if (sessionStr) {
    try {
      const session = JSON.parse(sessionStr);
      if (session.role === 'admin') {
        updateUserBadge(session.name || 'Administrator');
        handleRoute();
        return;
      } else if (session.empNo) {
        const emp = EMPLOYEES.find(e => e.empNo === session.empNo);
        if (emp) {
          currentUser = emp;
          updateUserBadge(emp.name);
          handleRoute();
          return;
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
  
  if (!window.location.hash) {
    navigateTo('/');
  } else {
    handleRoute();
  }
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
function handleEmpLogin(e) {
  e.preventDefault();
  const empIdVal = document.getElementById('empIdInput').value.trim();
  
  if (!empIdVal) {
 showToast('Please enter a valid Employee ID');
    return;
  }

  const emp = EMPLOYEES.find(e => e.empNo === empIdVal || e.empNo === '0' + empIdVal);
  if (!emp) {
 showToast('Employee ID not found in database!');
    return;
  }

  currentUser = emp;
  localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({ role: 'emp', empNo: emp.empNo }));
  updateUserBadge(emp.name);

  navigateTo('/employee/dashboard');
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
// ADMIN AUTHENTICATION (Testing Mode: username: admin / password: admin123)
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

  // Direct credential verification for testing mode (supports both offline & online)
  if (username === 'admin' && password === 'admin123') {
    const adminName = 'Administrator';
    localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({
      role: 'admin',
      username: 'admin',
      email: 'admin@yokohama.com',
      name: adminName
    }));
    updateUserBadge(adminName);
 showToast('Authenticated successfully as Administrator');
    navigateTo('/secure-control/dashboard');

    // Also sync session with backend if reachable
    fetch('/api/auth/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).catch(() => {});
    return;
  }

  // Backend verification check
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
 showToast(data.message || 'Invalid username or password (Testing mode: admin / admin123)');
    }
  } catch (err) {
 showToast('Invalid username or password (Testing mode: admin / admin123)');
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
    await fetch('/api/auth/admin/logout', { method: 'POST' });
  } catch (e) {
    console.error(e);
  }
  localStorage.removeItem(STORAGE_KEY_SESSION);
  currentUser = null;
  activeExam = null;
  navigateTo('/');
}

// ---------------------------------------------------------------------
// EMPLOYEE VIEWS (/employee/*)
// ---------------------------------------------------------------------
function showEmpDashboard() {
  if (!currentUser) return;

  const currentLevel = currentUser.currentLevel || 'I';
  const currentRules = LEVEL_RULES[currentLevel] || LEVEL_RULES['I'];
  const targetLevel = currentRules.nextLevel;
  const targetRules = LEVEL_RULES[targetLevel] || LEVEL_RULES['L'];

  currentUser.targetLevel = targetLevel;

 document.getElementById('infoEmpNo').innerText = currentUser.empNo;
 document.getElementById('infoEmpName').innerText = currentUser.name;
 document.getElementById('infoEmpDept').innerText = `${currentUser.dept} / ${currentUser.section || 'QA'}`;
 document.getElementById('infoEmpDoj').innerText = currentUser.doj || 'N/A';
 document.getElementById('infoTargetLevel').innerText = `${targetLevel} Level Assessment (${targetRules.numQuestions} Qs)`;

  showView('viewEmpDashboard');
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
function startOrResumeExam() {
  if (!currentUser) return;

  const targetLevel = currentUser.targetLevel || 'L';
  const sectionQuestions = getQuestionsForSection(targetLevel, currentUser.section);

  const records = getStoredRecords();
  let empRecord = records[currentUser.empNo];

  if (empRecord && empRecord.inProgress && !empRecord.isCompleted) {
    activeExam = {
      empNo: currentUser.empNo,
      targetLevel: targetLevel,
      questions: empRecord.questions || sectionQuestions,
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
      questions: sectionQuestions,
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

// Submit & Scoring Engine
function submitAssessment() {
  if (timerInterval) clearInterval(timerInterval);
  if (!activeExam) return;

  activeExam.isCompleted = true;

  const questions = activeExam.questions;
  const responses = activeExam.responses;
  let correctCount = 0;

  questions.forEach(q => {
    if (responses[q.id] && responses[q.id] === q.correctAnswer) {
      correctCount++;
    }
  });

  const totalQs = questions.length;
  const markPct = Math.round((correctCount / totalQs) * 100);

  const currentLevel = currentUser ? currentUser.currentLevel : 'I';
  const rules = LEVEL_RULES[currentLevel] || LEVEL_RULES['I'];
  const pass = markPct >= rules.passingPct;

  let uMark = 0, lMark = 0, oMark = 0;
  if (activeExam.targetLevel === 'U') uMark = correctCount;
  else if (activeExam.targetLevel === 'L') lMark = correctCount;
  else if (activeExam.targetLevel === 'O') oMark = correctCount;

  const submittedQuestions = questions.map((q, idx) => {
    const selKey = responses[q.id] || 'Not Answered';
    const selOpt = q.options ? q.options.find(o => o.key === selKey) : null;
    const corrOpt = q.options ? q.options.find(o => o.key === q.correctAnswer) : null;
    return {
      index: idx + 1,
      id: q.id,
      category: q.category || 'General QA',
      question: q.question,
      selectedKey: selKey,
      selectedText: selOpt ? selOpt.text : 'Not Answered',
      correctKey: q.correctAnswer,
      correctText: corrOpt ? corrOpt.text : '',
      isCorrect: selKey === q.correctAnswer,
      options: q.options || []
    };
  });

  const recordData = {
    empNo: currentUser.empNo,
    name: currentUser.name,
    dept: currentUser.dept,
    section: currentUser.section,
    doj: currentUser.doj,
    targetLevel: activeExam.targetLevel,
    inProgress: false,
    isCompleted: true,
    tabSwitchCount: activeExam.tabSwitchCount || 0,
    responses: responses,
    submittedQuestions: submittedQuestions,
    attemptedCount: Object.keys(responses).length,
    uMark: uMark,
    lMark: lMark,
    oMark: oMark,
    totalMark: correctCount,
    markPct: markPct,
    status: pass ? 'Passed' : 'Failed',
    attemptDate: new Date().toLocaleDateString('en-GB')
  };

  recordData.empNo = currentUser.empNo;
  window.lastCompletedEmpNo = currentUser.empNo;
  saveRecord(currentUser.empNo, recordData);
  showResultView(recordData, true);
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

function downloadCurrentEmployeePDF() {
  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  const session = sessionStr ? JSON.parse(sessionStr) : null;
  if (!session || !session.empNo) return alert('Session expired or employee not logged in.');
  downloadEmployeePDF(session.empNo);
}

function downloadCurrentEmployeeDocx() {
  const sessionStr = localStorage.getItem(STORAGE_KEY_SESSION);
  const session = sessionStr ? JSON.parse(sessionStr) : null;
  if (!session || !session.empNo) return alert('Session expired or employee not logged in.');
  downloadEmployeeDocx(session.empNo);
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
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button type="button" class="btn-primary" style="padding: 4px 10px; font-size: 0.76rem; background: #005B9E; border-color: #005B9E;" onclick="showSectionCompletedModal('${sec.id}')">
            View List
          </button>
          <button type="button" class="btn-secondary" style="padding: 4px 8px; font-size: 0.76rem;" onclick="navigateTo('/control-center/sections'); renderSectionsExplorer('${sec.id}');">
            Explorer
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
          ${hasExam ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #0284C7; border-color: #0284C7;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download PDF Report">PDF</button>` : ''}
          ${hasExam ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>` : ''}
          <button class="btn-primary" style="padding: 3px 8px; font-size: 0.72rem; background: #059669; border-color: #059669;" onclick="closeSectionCompletedModal(); openOjtModalForEmployee('${emp.empNo}')">OJT</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPieChart(completed, inProgress, notStarted) {
  const ctx = document.getElementById('completionPieChart').getContext('2d');
  if (pieChartInstance) pieChartInstance.destroy();

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
}

function renderBarChart(records) {
  const ctx = document.getElementById('levelBarChart').getContext('2d');
  if (barChartInstance) barChartInstance.destroy();

  let uCount = 0, lCount = 0, oCount = 0, iCount = 0;

  EMPLOYEES.forEach(emp => {
    const lvl = emp.currentLevel || 'I';
    if (lvl === 'U') uCount++;
    else if (lvl === 'L') lCount++;
    else if (lvl === 'O') oCount++;
    else iCount++;
  });

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
    const res = await fetch('/api/employees');
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
    fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employees: EMPLOYEES })
    }).catch(err => console.log('Employees sync pending:', err.message));
  } catch (e) {}
}

async function syncCloudSettings() {
  try {
    const res = await fetch('/api/settings');
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
        ${hasRecord ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #0284C7; border-color: #0284C7;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download PDF Report">PDF</button>` : ''}
        ${hasRecord ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>` : ''}
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

// Download PDF Evaluation Report for Employee Assessment
function downloadEmployeePDF(empNo) {
  const records = getStoredRecords();
  const rec = records[empNo] || {};
  const emp = (typeof EMPLOYEES !== 'undefined' ? EMPLOYEES : []).find(e => e.empNo === empNo);
  const allOjt = typeof getStoredOjtRecords === 'function' ? getStoredOjtRecords() : {};
  const ojt = allOjt[empNo] || null;

  const empName = emp ? emp.name : (rec.name || empNo);
  const empDept = emp ? emp.dept : (rec.dept || 'QUALITY CONTROL');
  const empSection = emp ? (emp.section || rec.section || '-') : (rec.section || '-');
  const empDoj = emp ? (emp.doj || rec.doj || '-') : (rec.doj || '-');
  const currLevel = emp ? (emp.currentLevel || 'I') : 'I';

  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
  const targetLevel = rec.targetLevel || targetMap[currLevel] || 'L';
  const isAttempted = !!(rec.isCompleted || rec.inProgress);
  const status = isAttempted ? (rec.status || (rec.isCompleted ? 'Completed' : 'In Progress')) : 'Not Attempted';
  const isPass = status === 'Passed';

  // Practical OJT status
  const hasOjt = !!(ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined));
  const ojtScore = hasOjt ? (ojt.totalScore || 0) : 0;
  const ojtMax = hasOjt ? (ojt.maxScore || 50) : 50;
  const ojtMinPass = Math.ceil(ojtMax * 0.7);
  const ojtQualified = hasOjt && (ojt.qualificationStatus === 'Qualified' || ojtScore >= ojtMinPass);

  // Build question list for PDF
  let qList = rec.submittedQuestions || [];
  if (qList.length === 0 && rec.responses) {
    const matchedQs = typeof getQuestionsForSection === 'function' ? getQuestionsForSection(targetLevel, empSection) : [];
    qList = matchedQs.map((q, idx) => {
      const selKey = rec.responses[q.id] || 'Not Answered';
      const selOpt = q.options ? q.options.find(o => o.key === selKey) : null;
      const corrOpt = q.options ? q.options.find(o => o.key === q.correctAnswer) : null;
      return {
        index: idx + 1,
        id: q.id,
        category: q.category || 'General QA',
        question: q.question,
        selectedKey: selKey,
        selectedText: selOpt ? selOpt.text : 'Not Answered',
        correctKey: q.correctAnswer,
        correctText: corrOpt ? corrOpt.text : '',
        isCorrect: selKey === q.correctAnswer,
        options: q.options || []
      };
    });
  }

  const totalQs = qList.length > 0 ? qList.length : 30;
  const mcqMinPass = Math.ceil(totalQs * 0.7);
  const mcqScore = rec.totalMark !== undefined ? rec.totalMark : (isAttempted ? 0 : null);

  // Overall status evaluation (Strictly Marks Only, Zero %)
  let overallBadgeText = 'ASSESSMENT PENDING';
  let overallBadgeBg = '#F1F5F9';
  let overallBadgeColor = '#475569';
  let overallBadgeBorder = '#CBD5E1';

  if (isPass && ojtQualified) {
    overallBadgeText = `QUALIFIED • PROMOTED TO ${targetLevel} LEVEL`;
    overallBadgeBg = '#DCFCE7';
    overallBadgeColor = '#166534';
    overallBadgeBorder = '#86EFAC';
  } else if (isPass && !hasOjt) {
    overallBadgeText = 'THEORY PASSED • OJT EVALUATION PENDING';
    overallBadgeBg = '#E0F2FE';
    overallBadgeColor = '#0369A1';
    overallBadgeBorder = '#BAE6FD';
  } else if (!isPass && isAttempted && hasOjt && ojtQualified) {
    overallBadgeText = 'OJT QUALIFIED • THEORY RETEST REQUIRED';
    overallBadgeBg = '#FEF3C7';
    overallBadgeColor = '#92400E';
    overallBadgeBorder = '#FDE68A';
  } else if (isAttempted && !isPass) {
    overallBadgeText = 'RETEST REQUIRED • MINIMUM MARKS NOT MET';
    overallBadgeBg = '#FEE2E2';
    overallBadgeColor = '#991B1B';
    overallBadgeBorder = '#FCA5A5';
  }

  // Anti-cheating & Tab switches
  const tabSwitches = rec.tabSwitchCount || 0;
  const isTerminated = tabSwitches > 3;

  // Build OJT Checkpoints summary block
  let ojtSectionHtml = '';
  if (hasOjt) {
    const ojtTemplate = typeof getOjtTemplateForSection === 'function' ? getOjtTemplateForSection(empSection) : null;
    const checkpoints = (ojtTemplate && ojtTemplate.checkpoints) ? ojtTemplate.checkpoints : [];
    const scores = ojt.scores || {};

    const cpRows = checkpoints.length > 0 ? checkpoints.map(cp => {
      const sc = scores[cp.sno] !== undefined ? scores[cp.sno] : '-';
      return `
        <tr style="border-bottom: 1px solid #E2E8F0; font-size: 10px;">
          <td style="padding: 4px 6px; text-align: center; font-weight: 700; color: #64748B;">${cp.sno}</td>
          <td style="padding: 4px 8px; color: #1E293B;">${cp.text}</td>
          <td style="padding: 4px 8px; text-align: center; font-weight: 800; color: #005B9E;">${sc} / 5 Marks</td>
        </tr>
      `;
    }).join('') : '';

    ojtSectionHtml = `
      <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; margin-bottom: 14px; border: 1px solid #E2E8F0; border-radius: 6px; background: #FFFFFF; overflow: hidden;">
        <div style="background: #F8FAFC; padding: 7px 12px; border-bottom: 1px solid #E2E8F0; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-size: 11px; font-weight: 800; color: #002B49; letter-spacing: 0.3px;">PRACTICAL ON-THE-JOB TRAINING (OJT) EVALUATION</span>
            <span style="font-size: 9.5px; color: #64748B; margin-left: 8px;">${ojt.formatNo || (ojtTemplate ? ojtTemplate.formatNo : '')}</span>
          </div>
          <span style="font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 10px; background: ${ojtQualified ? '#DCFCE7' : '#FEE2E2'}; color: ${ojtQualified ? '#166534' : '#991B1B'}; border: 1px solid ${ojtQualified ? '#86EFAC' : '#FCA5A5'};">
            ${ojt.qualificationStatus || (ojtQualified ? 'Qualified' : 'Not Qualified')} &bull; ${ojtScore} / ${ojtMax} Marks
          </span>
        </div>
        ${cpRows ? `
          <table style="width: 100%; border-collapse: collapse; text-align: left;">
            <thead>
              <tr style="background: #F1F5F9; font-size: 9.5px; text-transform: uppercase; color: #475569; border-bottom: 1px solid #CBD5E1;">
                <th style="padding: 4px 6px; width: 35px; text-align: center;">S.No</th>
                <th style="padding: 4px 8px;">Evaluation Practical Checkpoint</th>
                <th style="padding: 4px 8px; width: 100px; text-align: center;">Marks Awarded</th>
              </tr>
            </thead>
            <tbody>
              ${cpRows}
            </tbody>
          </table>
        ` : ''}
        <div style="padding: 6px 10px; background: #F8FAFC; border-top: 1px solid #E2E8F0; font-size: 9.5px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div><strong>Improvement Comments:</strong> ${ojt.comments || 'Practical evaluation satisfactory.'}</div>
          <div style="text-align: right; color: #475569;">
            <span>Safety: <strong>${ojt.safetyRep || '-'}</strong></span> | 
            <span>Quality: <strong>${ojt.qualityRep || '-'}</strong></span> | 
            <span>CI: <strong>${ojt.ciRep || '-'}</strong></span>
          </div>
        </div>
      </div>
    `;
  } else {
    ojtSectionHtml = `
      <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; margin-bottom: 14px; padding: 7px 12px; background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 6px; font-size: 10px; color: #64748B; display: flex; justify-content: space-between; align-items: center;">
        <div><strong>Practical OJT Status:</strong> In-section evaluation is pending for this employee. Practical evaluation marks will append upon supervisor submission.</div>
        <span style="font-weight: 700; color: #D97706; background: #FEF3C7; padding: 2px 7px; border-radius: 8px; font-size: 9.5px; border: 1px solid #FDE68A;">Pending</span>
      </div>
    `;
  }

  // Build Questions HTML (compact, unbreakable rows)
  const questionsHtml = qList.length > 0 ? qList.map((q, idx) => {
    const qIndex = q.index || (idx + 1);
    const isCorr = !!q.isCorrect;
    const borderLeftColor = isCorr ? '#10B981' : '#EF4444';
    const bgBadge = isCorr ? '#DCFCE7' : '#FEE2E2';
    const textBadge = isCorr ? '#166534' : '#991B1B';
    const badgeText = isCorr ? 'Correct (1 Mark)' : 'Incorrect (0 Marks)';

    return `
      <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; margin-bottom: 6px; border: 1px solid #E2E8F0; border-radius: 5px; padding: 5px 8px; background: ${isCorr ? '#FFFFFF' : '#FFF9F9'}; border-left: 3.5px solid ${borderLeftColor};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 3px;">
          <div style="font-size: 10.5px; font-weight: 700; color: #1E293B; line-height: 1.35; padding-right: 8px;">
            <span style="color: #005B9E; margin-right: 3px;">Q${qIndex}.</span>
            <span style="color: #64748B; font-weight: 600; font-size: 9px; margin-right: 5px;">[${q.category || 'General QA'}]</span>
            <span style="color: #0F172A;">${q.question}</span>
          </div>
          <div style="white-space: nowrap;">
            <span style="font-size: 9px; font-weight: 700; padding: 1.5px 6px; border-radius: 3px; background: ${bgBadge}; color: ${textBadge}; border: 1px solid ${isCorr ? '#86EFAC' : '#FCA5A5'};">
              ${badgeText}
            </span>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 9.5px; margin-top: 3px;">
          <div style="background: ${isCorr ? '#ECFDF5' : '#FEF2F2'}; border: 1px solid ${isCorr ? '#A7F3D0' : '#FECACA'}; padding: 3px 6px; border-radius: 3px;">
            <strong style="color: ${isCorr ? '#065F46' : '#991B1B'};">Candidate:</strong>
            <span style="color: #0F172A;">[${q.selectedKey}] ${q.selectedText}</span>
          </div>
          <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 3px 6px; border-radius: 3px;">
            <strong style="color: #334155;">Key:</strong>
            <span style="color: #0F172A;">[${q.correctKey}] ${q.correctText}</span>
          </div>
        </div>
      </div>
    `;
  }).join('') : `
    <div style="padding: 14px; border: 1px dashed #CBD5E1; border-radius: 6px; background: #F8FAFC; text-align: center; color: #64748B; font-size: 11px;">
      Candidate has not attempted this assessment yet. Question and response audit will appear once submitted.
    </div>
  `;

  // Build temporary printable container
  const reportDiv = document.createElement('div');
  reportDiv.id = 'pdfReportTempContainer';
  reportDiv.style.width = '730px';
  reportDiv.style.margin = '0 auto';
  reportDiv.style.padding = '12px 14px';
  reportDiv.style.boxSizing = 'border-box';
  reportDiv.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  reportDiv.style.color = '#0F172A';
  reportDiv.style.background = '#FFFFFF';

  reportDiv.innerHTML = `
    <!-- Top Yokohama Brand Bar -->
    <div style="display: flex; height: 5px; margin-bottom: 12px; border-radius: 3px; overflow: hidden;">
      <div style="width: 35%; background: #E31B23;"></div>
      <div style="width: 65%; background: #002B49;"></div>
    </div>

    <!-- Header Block -->
    <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #005B9E; padding-bottom: 8px; margin-bottom: 12px;">
      <div>
        <div style="font-size: 17px; font-weight: 800; color: #002B49; letter-spacing: 0.5px;">YOKOHAMA OFF-HIGHWAY TIRES</div>
        <div style="font-size: 10px; font-weight: 700; color: #64748B; letter-spacing: 0.3px; margin-top: 1px;">
          ATC TIRES PVT. LTD. &bull; QUALITY ASSURANCE &mdash; ILUO QUALIFICATION REPORT
        </div>
      </div>
      <div style="text-align: right;">
        <span style="background: ${overallBadgeBg}; color: ${overallBadgeColor}; border: 1px solid ${overallBadgeBorder}; padding: 4px 12px; border-radius: 16px; font-weight: 800; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.3px; display: inline-block;">
          ${overallBadgeText}
        </span>
      </div>
    </div>

    <!-- Employee Metadata Grid -->
    <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px;">
      <div style="display: grid; grid-template-columns: 1fr 1.2fr 1fr 1fr; gap: 8px 12px; font-size: 10.5px;">
        <div><strong style="color: #64748B;">Emp No:</strong> <span style="color: #005B9E; font-weight: 800;">${empNo}</span></div>
        <div><strong style="color: #64748B;">Name:</strong> <strong style="color: #0F172A;">${empName}</strong></div>
        <div><strong style="color: #64748B;">Department:</strong> <span>${empDept}</span></div>
        <div><strong style="color: #64748B;">Section:</strong> <strong style="color: #005B9E;">${empSection}</strong></div>
        <div><strong style="color: #64748B;">DOJ:</strong> <span>${empDoj}</span></div>
        <div><strong style="color: #64748B;">Skill Level:</strong> <span style="font-weight: 700; color: #0284C7;">${currLevel} &rarr; ${targetLevel} Assessment</span></div>
        <div><strong style="color: #64748B;">Exam Date:</strong> <span>${rec.attemptDate || new Date().toLocaleDateString('en-GB')}</span></div>
        <div><strong style="color: #64748B;">Proctoring:</strong> <span style="color: ${tabSwitches > 0 ? '#E31B23' : '#166534'}; font-weight: 700;">${tabSwitches === 0 ? '0 Warnings (Clean)' : `${tabSwitches} Tab Alerts`}</span></div>
      </div>
    </div>

    <!-- Scorecard Summary Box (Strictly Marks Only, No %) -->
    <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; display: grid; grid-template-columns: 1fr 1fr 1.15fr; gap: 8px; margin-bottom: 14px; text-align: center;">
      <!-- Theory MCQ Card -->
      <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 8px 6px; border-radius: 6px;">
        <div style="font-size: 9.5px; color: #1E40AF; text-transform: uppercase; font-weight: 800;">MCQ Theory Assessment</div>
        <div style="font-size: 18px; font-weight: 800; color: #1E3A8A; margin: 2px 0;">
          ${mcqScore !== null ? `${mcqScore} / ${totalQs} Marks` : '-'}
        </div>
        <div style="font-size: 9px; color: #3B82F6; font-weight: 600;">Standard: ${mcqMinPass} Marks Required</div>
        <div style="margin-top: 3px;">
          <span style="font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 8px; background: ${isPass ? '#DCFCE7' : (isAttempted ? '#FEE2E2' : '#F1F5F9')}; color: ${isPass ? '#166534' : (isAttempted ? '#991B1B' : '#475569')};">
            ${isPass ? 'Passed Standard' : (isAttempted ? 'Failed Standard' : 'Pending')}
          </span>
        </div>
      </div>

      <!-- Practical OJT Card -->
      <div style="background: #F0FDF4; border: 1px solid #BBF7D0; padding: 8px 6px; border-radius: 6px;">
        <div style="font-size: 9.5px; color: #166534; text-transform: uppercase; font-weight: 800;">Practical OJT Evaluation</div>
        <div style="font-size: 18px; font-weight: 800; color: #14532D; margin: 2px 0;">
          ${hasOjt ? `${ojtScore} / ${ojtMax} Marks` : 'Pending'}
        </div>
        <div style="font-size: 9px; color: #16A34A; font-weight: 600;">Standard: ${ojtMinPass} Marks Required</div>
        <div style="margin-top: 3px;">
          <span style="font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 8px; background: ${hasOjt ? (ojtQualified ? '#DCFCE7' : '#FEE2E2') : '#FEF3C7'}; color: ${hasOjt ? (ojtQualified ? '#166534' : '#991B1B') : '#92400E'};">
            ${hasOjt ? (ojtQualified ? 'Qualified' : 'Not Qualified') : 'Pending Practical'}
          </span>
        </div>
      </div>

      <!-- Combined Overall Score Card -->
      <div style="background: #FAF5FF; border: 1px solid #E9D5FF; padding: 8px 6px; border-radius: 6px;">
        <div style="font-size: 9.5px; color: #6B21A8; text-transform: uppercase; font-weight: 800;">Total Assessment Marks</div>
        <div style="font-size: 18px; font-weight: 800; color: #581C87; margin: 2px 0;">
          ${(mcqScore || 0) + ojtScore} / ${totalQs + (hasOjt ? ojtMax : 50)} Marks
        </div>
        <div style="font-size: 9px; color: #9333EA; font-weight: 600;">
          ILUO Level Target: <strong>${targetLevel} Level</strong>
        </div>
        <div style="margin-top: 3px;">
          <span style="font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 8px; background: ${overallBadgeBg}; color: ${overallBadgeColor}; border: 1px solid ${overallBadgeBorder};">
            ${overallBadgeText.split('•')[0].trim()}
          </span>
        </div>
      </div>
    </div>

    <!-- Practical OJT Checkpoints Section -->
    ${ojtSectionHtml}

    <!-- Question & Answer Audit Sheet -->
    <div style="margin-bottom: 14px;">
      <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; display: flex; justify-content: space-between; align-items: center; border-bottom: 1.5px solid #CBD5E1; padding-bottom: 4px; margin-bottom: 8px;">
        <h3 style="font-size: 12px; font-weight: 800; color: #0F172A; margin: 0; text-transform: uppercase; letter-spacing: 0.3px;">
          MCQ Theory Examination Audit Trail (${qList.length} Questions)
        </h3>
        <div style="font-size: 10px; font-weight: 700; color: #64748B;">
          <span style="color: #166534;">${rec.totalMark !== undefined ? rec.totalMark : 0} Correct</span> &bull; 
          <span style="color: #991B1B;">${totalQs - (rec.totalMark !== undefined ? rec.totalMark : 0)} Incorrect</span>
        </div>
      </div>

      <!-- Question List -->
      ${questionsHtml}
    </div>

    <!-- Signatures Block (Unbreakable) -->
    <div class="pdf-avoid-break" style="page-break-inside: avoid !important; break-inside: avoid !important; margin-top: 14px; padding-top: 10px; border-top: 1.5px solid #CBD5E1; font-size: 10px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; text-align: center;">
        <div style="border: 1px solid #E2E8F0; border-radius: 6px; padding: 8px 6px; background: #F8FAFC;">
          <div style="height: 32px; border-bottom: 1px dashed #94A3B8; margin-bottom: 5px;"></div>
          <strong style="color: #0F172A; display: block; font-size: 10px;">Candidate Signature</strong>
          <span style="color: #64748B; font-size: 9px;">${empName} (${empNo})</span>
        </div>
        <div style="border: 1px solid #E2E8F0; border-radius: 6px; padding: 8px 6px; background: #F8FAFC;">
          <div style="height: 32px; border-bottom: 1px dashed #94A3B8; margin-bottom: 5px;"></div>
          <strong style="color: #0F172A; display: block; font-size: 10px;">QA Section Evaluator</strong>
          <span style="color: #64748B; font-size: 9px;">Technical Incharge / Supervisor</span>
        </div>
        <div style="border: 1px solid #E2E8F0; border-radius: 6px; padding: 8px 6px; background: #F8FAFC;">
          <div style="height: 32px; border-bottom: 1px dashed #94A3B8; margin-bottom: 5px;"></div>
          <strong style="color: #0F172A; display: block; font-size: 10px;">QA Department Manager</strong>
          <span style="color: #64748B; font-size: 9px;">Plant Quality Approval &amp; Seal</span>
        </div>
      </div>
      <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 8.5px; color: #94A3B8;">
        <span>YOKOHAMA OFF-HIGHWAY TIRES &bull; OFFICIAL QA ILUO AUDIT RECORD &bull; STRICTLY CONFIDENTIAL</span>
        <span>Generated: ${new Date().toLocaleString('en-GB')}</span>
      </div>
    </div>
  `;

  document.body.appendChild(reportDiv);
  showToast(`Generating optimized PDF report for ${empNo}...`);

  if (typeof html2pdf !== 'undefined') {
    const opt = {
      margin: [8, 8, 8, 8],
      filename: `Yokohama_ILUO_Report_${empNo}_${empName.replace(/\s+/g, '_')}.pdf`,
      image: { type: 'jpeg', quality: 0.90 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        scrollY: 0,
        scrollX: 0,
        logging: false,
        letterRendering: true
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait',
        compress: true
      },
      pagebreak: {
        mode: ['avoid-all', 'css', 'legacy'],
        avoid: ['.pdf-avoid-break', 'tr']
      }
    };

    html2pdf().from(reportDiv).set(opt).toContainer().toCanvas().toImg().toPdf().get('pdf').then(function(pdf) {
      const totalPages = pdf.internal.getNumberOfPages();
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setTextColor(148, 163, 184);
        pdf.text(
          `Yokohama Off-Highway Tires  •  QA ILUO Evaluation Report  •  Page ${i} of ${totalPages}`,
          pageWidth / 2,
          pageHeight - 4,
          { align: 'center' }
        );
      }
    }).save().then(() => {
      if (document.body.contains(reportDiv)) document.body.removeChild(reportDiv);
      showToast('PDF Report downloaded successfully!');
    }).catch(err => {
      console.error('PDF export error:', err);
      if (document.body.contains(reportDiv)) document.body.removeChild(reportDiv);
      window.print();
    });
  } else {
    window.print();
    if (document.body.contains(reportDiv)) document.body.removeChild(reportDiv);
  }
}

// Download Official DOCX Evaluation Report for Employee Assessment
async function downloadEmployeeDocx(empNo) {
  if (!empNo) return alert('Employee ID is required.');
  showToast(`Generating official Word Document (.docx) report for Employee ${empNo}...`);

  try {
    const records = getStoredRecords();
    const recordData = records[empNo] || null;

    let res = await fetch('/api/generate-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: String(empNo), recordData })
    });

    if (!res.ok) {
      // Fallback to GET endpoint
      res = await fetch(`/api/employee-docx/${encodeURIComponent(empNo)}`);
    }

    if (res.ok) {
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
    } else {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || 'Server returned status ' + res.status);
    }
  } catch (err) {
    console.error('DOCX Download error:', err);
    showToast(`Could not generate DOCX: ${err.message}. Please verify local server is running.`);
  }
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

// Bulk Clear & Docx Upload Parser
function clearAllQuestions() {
  if (!confirm('⚠️ WARNING: Are you sure you want to DELETE ALL QUESTIONS?\n\nThis will clear the entire question bank. You can then upload your own custom .docx files!')) return;

  QUESTION_BANK.L = [];
  QUESTION_BANK.U = [];
  QUESTION_BANK.O = [];

  saveCustomQuestionsToServer();
 showToast('All questions deleted! Question bank is now empty.');
  renderQuestionsManager();
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

let currentActiveSectionKey = 'warehouse'; // Default to Ware House QA
let currentActiveSectionTab = 'employees';

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
  const searchInput = document.getElementById('secEmpSearchInput');
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

  const countElem = document.getElementById('secEmpTableCount');
 if (countElem) countElem.innerText = sectionEmps.length;

  const tbody = document.getElementById('secEmpTableBody');
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
        ${hasRecord ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #0284C7; border-color: #0284C7;" onclick="downloadEmployeePDF('${emp.empNo}')" title="Download PDF Report">PDF</button>` : ''}
        ${hasRecord ? `<button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #1E3A8A; border-color: #1E3A8A;" onclick="downloadEmployeeDocx('${emp.empNo}')" title="Download Official Word Document (DOCX)">DOCX</button>` : ''}
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
// ON-THE-JOB TRAINING EVALUATION (OJT) ENGINE (D:\QA 7 Formats)
// ---------------------------------------------------------------------

const OJT_SECTION_TEMPLATES = {
  'rro_alt': {
    id: 'rro_alt',
    code: '83D',
    title: 'TN PLANT -    INDIVIDUAL ON THE JOB TRAINING EVALUATION  –  RRO & ALT',
    sectionName: 'Final Finish RRO & ALT QA',
    formatNo: 'Format No: ATC/T/FOR/HR/83D',
    fileName: '83D. ON THE JOB TRAINING EVALUATION -  RRO & ALT Operator.xlsx',
    checkpoints: [
      { sno: 1, text: 'Plant Safety Awareness (BBs, HSEE, PPE, LOTO, Electrical safety, etc.,)' },
      { sno: 2, text: 'Basic 5S on shop floor.' },
      { sno: 3, text: 'Hands-on knowledge of size, engraving description, QR sticker knowledge' },
      { sno: 4, text: 'EOT operating skill during rim change.' },
      { sno: 5, text: 'Hands-on Skills on RRO, RRM and ALT operation – Master tire verification, OD verification, Scanning, Poka Yoke and standards' },
      { sno: 6, text: 'Knowledge on hold tire handling procedure, reverification, disposal.' },
      { sno: 7, text: 'Knowledge of FIFO & Clearing of old tires on time.' },
      { sno: 8, text: 'TEI ( Knowledge of QCC, OPL, Kaizen, Suggestion etc.,)' }
    ],
    maxScore: 40
  },
  'final_finish': {
    id: 'final_finish',
    code: '84D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION – FINAL FINISH REPAIR ASSOCIATE',
    sectionName: 'Final Finish QA',
    formatNo: 'Format No: ATC/T/FOR/HR/84D',
    fileName: '84D. ON THE JOB TRAINING EVALUATION -  Final Finish Repair Associate.xlsx',
    checkpoints: [
      { sno: 1, text: 'Plant Safety Awareness (BBs,  PPE, naphtha handling etc.,)' },
      { sno: 2, text: 'Basic 5S on shop floor.' },
      { sno: 3, text: 'AMR basic operation and tire loading and unloading' },
      { sno: 4, text: 'Knowledge & Adherence of Flash cutting & Vent trimming Work Instruction and standards.' },
      { sno: 5, text: 'Knowledge of type of paint and respective tire usage' },
      { sno: 6, text: 'Segregation of crayon marked tires – LTC, Sample, Pilot, Repair and Hold tires' },
      { sno: 7, text: 'TEI ( Knowledge of QCC, OPL, Kaizen, Suggestion etc.,)' }
    ],
    maxScore: 35
  },
  'preparatory': {
    id: 'preparatory',
    code: '85D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION - PREPARATORY QA',
    sectionName: 'Preparatory QA',
    formatNo: 'Format No: ATC/T/FOR/HR/85D',
    fileName: '85D. ON THE JOB TRAINING EVALUATION - Preparatory QA.xlsx',
    checkpoints: [
      { sno: 1, text: 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety,)' },
      { sno: 2, text: 'Machine cleanliness and material handling' },
      { sno: 3, text: 'Verification on – NSNL /MES/Scanning and recipe /Guide light / Pressure gauge/ material Guider centering/ TCU temperature /Poka yoke' },
      { sno: 4, text: 'Measurement of Ply angle and skiving angle' },
      { sno: 5, text: 'Material measurement and knowledge on measuring tool' },
      { sno: 6, text: 'Material direction (Ply/breaker/belt) or material positioning of band building' },
      { sno: 7, text: 'Understand and read for IPS & MSS requirements' },
      { sno: 8, text: 'Verification of material aging and non-conformance handling with holding tags' },
      { sno: 9, text: 'Verification of Kanban system (FIFO)' },
      { sno: 10, text: 'TEI ( Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.,)' }
    ],
    maxScore: 50
  },
  'solid_tire': {
    id: 'solid_tire',
    code: '86D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION - Solid Tire QA',
    sectionName: 'Solid Tire QA',
    formatNo: 'Format No: ATC/T/FOR/HR/86D',
    fileName: '86D. ON THE JOB TRAINING EVALUATION - Solid Tire QA.xlsx',
    checkpoints: [
      { sno: 1, text: 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety & manipulator )' },
      { sno: 2, text: 'Verification of Press parameters steam temperature, Hydraulic Pressure gauges, Tower lamp working condition , bumping count, measurement (Equipment calibrations)' },
      { sno: 3, text: 'Verification on – NSNL /MES/Scanning and recipe' },
      { sno: 4, text: 'Verification of tire engraving covered as per route card' },
      { sno: 5, text: 'Cure cycle time verification as per specification' },
      { sno: 6, text: 'TBM-Verification of GT condition (Green tire ageing, off centre wind up, and / GT storage)' },
      { sno: 7, text: 'TBM-Verification for Drum pressure and conveyor pressure as well as green tires weight.' },
      { sno: 8, text: 'TBM-Verification on – Guide light / Guider centring/ TCU temperature /Pokayoke' },
      { sno: 9, text: 'Material measurement and knowledge on measuring tool' },
      { sno: 10, text: 'NC material handling' }
    ],
    maxScore: 50
  },
  'tire_building': {
    id: 'tire_building',
    code: '87D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION -TBM QA',
    sectionName: 'Tire Building QA',
    formatNo: 'Format No: ATC/T/FOR/HR/87D',
    fileName: '87D. ON THE JOB TRAINING EVALUATION - TBM QA.xlsx',
    checkpoints: [
      { sno: 1, text: 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety,)' },
      { sno: 2, text: 'Machine cleanliness and material handling' },
      { sno: 3, text: 'Verification for BPR parameter & centering.' },
      { sno: 4, text: 'Verification of Drum parameter with filling of the drum change memo and FTC sheet.' },
      { sno: 5, text: 'Bottom / Back stitcher tool gap and play verification.' },
      { sno: 6, text: 'Verification on – NSNL /MES/SKU sticker and recipe /Guide light / Pressure gauge/ material Guider centering/ TCU temperature /Pokayoke' },
      { sno: 7, text: 'Material measurement and knowledge on measuring tool' },
      { sno: 8, text: 'Material direction (Ply/breaker/belt) or material positioning for uncommon size.' },
      { sno: 9, text: 'CC/ GT defect checking and NC material handling' },
      { sno: 10, text: 'TEI ( Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.,)' }
    ],
    maxScore: 50
  },
  'tire_curing': {
    id: 'tire_curing',
    code: '88D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION  - TIRE CURING QA',
    sectionName: 'Tire Curing QA',
    formatNo: 'Format No: ATC/T/FOR/HR/88D',
    fileName: '88D. ON THE JOB TRAINING EVALUATION - Tire Curing QA.xlsx',
    checkpoints: [
      { sno: 1, text: 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety & VCL )' },
      { sno: 2, text: 'Verification of Press parameters dome temperature, Pressure gauges, Tower lamp working condition , Bladder and sleeve height measurement (Equipment calibrations)' },
      { sno: 3, text: 'Verification on – NSNL /MES/Scanning and recipe' },
      { sno: 4, text: 'Verification of tire engraving covered as per route card' },
      { sno: 5, text: 'Cure cycle time verification as per specification' },
      { sno: 6, text: 'Verification of GT condition (Paint aging and application (Inner & outer)/ GT storage)' },
      { sno: 7, text: 'GT loading direction against route card' },
      { sno: 8, text: 'PCI machine pressure & flange width measurement (OD setting if applicable)' },
      { sno: 9, text: 'NC material handling' },
      { sno: 10, text: 'Knowledge of Measuring equipments Vernier caliper, Measuring tape, Steel rule, dial gauge and Lux meter.' }
    ],
    maxScore: 50
  },
  'warehouse': {
    id: 'warehouse',
    code: '89D',
    title: 'TN PLANT - INDIVIDUAL ON THE JOB TRAINING EVALUATION - WAREHOUSE QA',
    sectionName: 'Warehouse QA',
    formatNo: 'Format No: ATC/T/FOR/HR/89D',
    fileName: '89D. ON THE JOB TRAINING EVALUATION -  WAREHOUSE QA.xlsx',
    checkpoints: [
      { sno: 1, text: 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety,)' },
      { sno: 2, text: 'Basic 5S on shop floor.' },
      { sno: 3, text: 'Precautions for forklift usage during tire loading inside the container.' },
      { sno: 4, text: 'OK tires and not ok tire identification and disposal.' },
      { sno: 5, text: 'Confirmation of PDI cleared tires.' },
      { sno: 6, text: 'Containment action and corrective action for customer complaints/feedbacks.' },
      { sno: 7, text: 'Aging requirements for outgoing product.' },
      { sno: 8, text: 'Poke Yoke in warehouse.' },
      { sno: 9, text: 'Purpose of bead vent/flash trimming on tubeless tires before dispatch.' },
      { sno: 10, text: 'TEI ( Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.,)' }
    ],
    maxScore: 50
  }
};

function getOjtTemplateForSection(secName) {
  const s = normalizeSectionName(secName);
  if (s.includes('rro') || s.includes('alt')) return OJT_SECTION_TEMPLATES['rro_alt'];
  if (s.includes('preparatory')) return OJT_SECTION_TEMPLATES['preparatory'];
  if (s.includes('solid')) return OJT_SECTION_TEMPLATES['solid_tire'];
  if (s.includes('building') || s.includes('tbm')) return OJT_SECTION_TEMPLATES['tire_building'];
  if (s.includes('curing')) return OJT_SECTION_TEMPLATES['tire_curing'];
  if (s.includes('warehouse') || s.includes('data entry') || s.includes('fid')) return OJT_SECTION_TEMPLATES['warehouse'];
  return OJT_SECTION_TEMPLATES['final_finish'];
}

function getStoredOjtRecords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_OJT)) || {};
  } catch (e) {
    return {};
  }
}

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

function openOjtModalQuick() {
  populateOjtEmployeeSwitcher();

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
  openOjtModalQuick();
}

function openOjtModalForEmployee(empNo) {
  const emp = EMPLOYEES.find(e => String(e.empNo).trim() === String(empNo).trim());
  if (!emp) {
    showToast(`Employee ${empNo} not found in directory.`);
    return;
  }

  activeOjtEmployee = emp;
  activeOjtTemplate = getOjtTemplateForSection(emp.section);

  const switcher = document.getElementById('ojtEmployeeSwitcher');
  if (switcher) {
    if (switcher.options.length <= 1) {
      populateOjtEmployeeSwitcher();
    }
    switcher.value = emp.empNo;
  }

  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
  const currLvl = emp.currentLevel || 'I';
  const targetLvl = targetMap[currLvl] || 'L';

  const records = getStoredRecords();
  const rec = records[empNo] || {};
  const assessmentDate = emp.assessmentDate || rec.attemptDate || new Date().toLocaleDateString('en-GB');

  const titleEl = document.getElementById('ojtModalHeaderTitle');
  if (titleEl) titleEl.innerText = activeOjtTemplate.title;

  const fmtEl = document.getElementById('ojtModalFormatNo');
  if (fmtEl) fmtEl.innerText = activeOjtTemplate.formatNo;

  const nameEl = document.getElementById('ojtEmpName');
  if (nameEl) nameEl.innerText = emp.name;

  const noEl = document.getElementById('ojtEmpNo');
  if (noEl) noEl.innerText = emp.empNo;

  const secEl = document.getElementById('ojtEmpSection');
  if (secEl) secEl.innerText = `${emp.section} / ${emp.dept}`;

  const dojEl = document.getElementById('ojtEmpDoj');
  if (dojEl) dojEl.innerText = emp.doj || '-';

  const lvlEl = document.getElementById('ojtEmpSkillLevel');
  if (lvlEl) lvlEl.innerText = `( ${currLvl} ) TO ( ${targetLvl} )`;

  const dateEl = document.getElementById('ojtAssessmentDate');
  if (dateEl) dateEl.innerText = assessmentDate;

  // Load existing saved evaluation if present
  const allOjt = getStoredOjtRecords();
  const existing = allOjt[empNo] || {};

  activeOjtScores = existing.scores ? { ...existing.scores } : {};

  const commEl = document.getElementById('ojtImprovementComments');
  if (commEl) commEl.value = existing.comments || '';

  const safeEl = document.getElementById('ojtSafetyRep');
  if (safeEl) safeEl.value = existing.safetyRep || '';

  const qualEl = document.getElementById('ojtQualityRep');
  if (qualEl) qualEl.value = existing.qualityRep || '';

  const ciEl = document.getElementById('ojtCiRep');
  if (ciEl) ciEl.value = existing.ciRep || '';

  // Render Checkpoint Rows
  const tbody = document.getElementById('ojtCheckpointsBody');
  if (tbody) {
    tbody.innerHTML = activeOjtTemplate.checkpoints.map((cp, idx) => {
      const currentScore = activeOjtScores[cp.sno] || 0;
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
        <tr style="border-bottom: 1px solid #E2E8F0; background: ${idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC'};">
          <td style="padding: 10px 12px; text-align: center; font-weight: 700; color: #64748B;">${cp.sno}</td>
          <td style="padding: 10px 14px; color: #1E293B; font-weight: 600;">${cp.text}</td>
          <td style="padding: 10px 14px; text-align: center;">
            <div class="ojt-score-group">
              ${buttonsHtml}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  updateOjtTotals();

  const modal = document.getElementById('modalOjtEvaluation');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('active');
    modal.scrollTop = 0;
  }
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

  // Update button active state in DOM for this checkpoint row
  const tbody = document.getElementById('ojtCheckpointsBody');
  if (tbody) {
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

function updateOjtTotals() {
  if (!activeOjtTemplate) return;

  const numCheckpoints = activeOjtTemplate.checkpoints.length;
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

  const isQualified = totalScore >= Math.round(maxScore * 0.7);

  const totalDisplay = document.getElementById('ojtTotalScoreDisplay');
  if (totalDisplay) {
    totalDisplay.innerText = `${totalScore} / ${maxScore} Marks`;
  }

  const badge = document.getElementById('ojtQualificationBadge');
  if (badge) {
    if (scoredCount === 0) {
      badge.style.background = '#FEF3C7';
      badge.style.color = '#D97706';
      badge.innerText = 'PENDING SCORING';
    } else if (isQualified) {
      badge.style.background = '#DCFCE7';
      badge.style.color = '#166534';
      badge.innerText = `QUALIFIED (${totalScore} / ${maxScore} Marks)`;
    } else {
      badge.style.background = '#FEE2E2';
      badge.style.color = '#B91C1C';
      badge.innerText = `NOT QUALIFIED (${totalScore} / ${maxScore} Marks)`;
    }
  }
}

function saveOjtEvaluationForm() {
  if (!activeOjtEmployee || !activeOjtTemplate) return;

  const numCheckpoints = activeOjtTemplate.checkpoints.length;
  const maxScore = numCheckpoints * 5;
  let totalScore = 0;
  activeOjtTemplate.checkpoints.forEach(cp => {
    totalScore += (activeOjtScores[cp.sno] || 0);
  });

  const pct = Math.round((totalScore / maxScore) * 100);
  const qualificationStatus = pct >= 70 ? 'Qualified' : 'Not Qualified';

  const ojtData = {
    empNo: activeOjtEmployee.empNo,
    name: activeOjtEmployee.name,
    section: activeOjtEmployee.section,
    templateCode: activeOjtTemplate.code,
    formatNo: activeOjtTemplate.formatNo,
    scores: { ...activeOjtScores },
    totalScore,
    maxScore,
    scorePct: pct,
    qualificationStatus,
    comments: document.getElementById('ojtImprovementComments').value.trim(),
    safetyRep: document.getElementById('ojtSafetyRep').value.trim(),
    qualityRep: document.getElementById('ojtQualityRep').value.trim(),
    ciRep: document.getElementById('ojtCiRep').value.trim(),
    evaluatedAt: new Date().toISOString().split('T')[0]
  };

  saveOjtRecord(activeOjtEmployee.empNo, ojtData);

  // If admin table is active, refresh it immediately
  if (document.getElementById('adminTableBody')) {
    const searchInput = document.getElementById('adminSearchInput');
    renderAdminTable(searchInput ? searchInput.value : '');
  }

  showToast(`OJT Evaluation saved successfully for Employee ${activeOjtEmployee.empNo} (${qualificationStatus})`);
}

function downloadCurrentOjtExcel() {
  if (!activeOjtEmployee || !activeOjtTemplate) return;

  saveOjtEvaluationForm();

  const emp = activeOjtEmployee;
  const tmpl = activeOjtTemplate;
  const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
  const currLvl = emp.currentLevel || 'I';
  const targetLvl = targetMap[currLvl] || 'L';

  const numCheckpoints = tmpl.checkpoints.length;
  const maxScore = numCheckpoints * 5;
  let totalScore = 0;
  tmpl.checkpoints.forEach(cp => {
    totalScore += (activeOjtScores[cp.sno] || 0);
  });
  const pct = Math.round((totalScore / maxScore) * 100);

  const comments = document.getElementById('ojtImprovementComments').value.trim();
  const safetyRep = document.getElementById('ojtSafetyRep').value.trim();
  const qualityRep = document.getElementById('ojtQualityRep').value.trim();
  const ciRep = document.getElementById('ojtCiRep').value.trim();

  const rows = [
    ["ATC TIRES PRIVATE LIMITED"],
    [tmpl.title],
    [],
    [`Name:  ${emp.name}`, "", "", "", "", `Emp ID:  ${emp.empNo}`, "", `Joining Date:  ${emp.doj || '-'}`],
    [`Section & Dept:  ${emp.section} / ${emp.dept}`, "", "", "", "", `Skill Level: ( ${currLvl} )   TO   ( ${targetLvl} )`, "", `Assessment Date:  ${new Date().toLocaleDateString('en-GB')}`],
    ["Rank", "1 =   POOR", "", "", "2 =   FAIR", "3 =   GOOD", "", "4 =   VERY GOOD", "", "5 =   EXCELLENT"],
    ["S.No", "Training Content / Check Point", "", "", "", "", "", "Score", "", "WI Check"]
  ];

  tmpl.checkpoints.forEach(cp => {
    const sc = activeOjtScores[cp.sno] || "";
    rows.push([cp.sno, cp.text, "", "", "", "", "", sc, "", ""]);
  });

  rows.push(["Total Score", "", "", "", "", "", "", `${totalScore}/${maxScore} = ${pct}%`, "", ""]);
  rows.push(["Improvement / Training requirement :", comments, "", "", "", "", "", "", "", ""]);
  rows.push([]);
  rows.push(["Evaluation By (Name & Sign with date)"]);
  rows.push(["Safety", "", "Quality", "", "", "", "", "", "CI"]);
  rows.push([safetyRep || "Section Representative", "", qualityRep || "Section Representative", "", "", "", "", "", ciRep || "Representative"]);
  rows.push([]);
  rows.push(["Qualification Status:", "", "", pct >= 70 ? "Qualified" : "Not Qualified", "", "", "Date of Reassessment"]);
  rows.push([tmpl.formatNo]);

  const cleanName = emp.name.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Yokohama_OJT_${emp.empNo}_${cleanName}`;

  try {
    if (typeof XLSX !== 'undefined') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, `${emp.empNo} - OJT Evaluation`);
      XLSX.writeFile(wb, `${filename}.xlsx`);
      showToast(`OJT Evaluation Excel (.xlsx) downloaded for Employee ${emp.empNo}!`);
    } else {
      const csvData = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\uFEFF' + csvData], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`OJT Evaluation downloaded as CSV for Employee ${emp.empNo}.`);
    }
  } catch (err) {
    console.error('OJT export error:', err);
    showToast('Download error: ' + err.message);
  }
}
