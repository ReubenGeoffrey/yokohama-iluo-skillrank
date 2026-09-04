// Yokohama ILUO MCQ Assessment Application Logic & Router

// LocalStorage Keys
const STORAGE_KEY_RECORDS = 'iluo_assessment_records_v1';
const STORAGE_KEY_SESSION = 'iluo_current_session_v1';

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
  syncCloudRecords();
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
      if (document.getElementById('questionsListContainer')) {
        renderQuestionsManager();
      }
    }
  } catch (e) {}
}

function saveCustomQuestionsToServer() {
  try {
    fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionBank: QUESTION_BANK })
    }).then(res => res.json()).then(data => {
      console.log('☁️ Question Bank Cloud Save Status:', data.message);
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
        showToast('🔒 Action restricted during assessment!');
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
        showToast('🔒 Keyboard shortcut blocked during assessment!');
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
        updateUserBadge(session.name || 'Reuben Geoffrey (Superadmin)');
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
  if (hash.startsWith('#/control-center') || hash === '#/admin-login') {
    navigateTo('/employee/login');
  } else {
    navigateTo('/admin-login');
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
        resendBtn.innerText = `🔄 Resend New OTP`;
      }
      showToast('⚠️ OTP Code Expired (1-minute validity limit)! Click Resend OTP.');
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

  showToast('📩 Sending OTP to ' + emailInput + ' via Gmail SMTP...');

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

      showToast(data.message || '✉️ OTP sent to your email inbox. Please check your Gmail and enter the 6-digit OTP.');
    } else {
      showToast('⚠️ ' + (data.message || 'Failed to send OTP'));
    }
  } catch (err) {
    console.error('API Error:', err);
    showToast('⚠️ Could not connect to authentication server. Please check your network or server status.');
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
      showToast(`✅ Authenticated successfully as ${adminName}`);
      navigateTo('/secure-control/dashboard');
    } else {
      showToast(`❌ ${data.message || 'Verification failed: Incorrect OTP code'}`);
    }
  } catch (err) {
    console.error('API Error:', err);
    showToast('❌ Verification error. Please try again.');
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
        <div style="font-size: 0.88rem; color: var(--text-muted); margin: 6px 0;">Status: <strong>${rec.status}</strong> | Score: ${rec.totalMark} Marks (${rec.markPct}%)</div>
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
    nextBtn.innerText = 'Submit Assessment ✔';
  } else {
    nextBtn.innerText = 'Next Question ➔';
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

  saveRecord(currentUser.empNo, recordData);
  showResultView(recordData, true);
}

function showResultView(record, isImmediateCompletion = false) {
  document.getElementById('resAttempted').innerText = `${record.attemptedCount || 0} Questions`;
  
  const totalMarks = record.totalMark !== undefined ? record.totalMark : (record.lMark || record.uMark || record.oMark || 0);
  const qCount = record.submittedQuestions ? record.submittedQuestions.length : (record.targetLevel === 'L' ? 20 : (record.targetLevel === 'U' ? 30 : 40));
  
  const resMarksEl = document.getElementById('resMarks');
  if (resMarksEl) resMarksEl.innerText = `${totalMarks} / ${qCount} Marks`;

  const resPctEl = document.getElementById('resPct');
  if (resPctEl) resPctEl.innerText = `${record.markPct !== undefined ? record.markPct + '%' : '-'}`;

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
    
    // Only show full question-by-question breakdown right after completing the exam!
    if (isImmediateCompletion && record.submittedQuestions && record.submittedQuestions.length > 0) {
      const qList = record.submittedQuestions;

      let html = `
        <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; padding: 14px; margin-bottom: 20px; font-size: 0.85rem; color: #92400E; display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.2rem;">⏱️</span>
          <div><strong>ONE-TIME RESULT AUDIT VIEW:</strong> This detailed question-by-question breakdown of your correct and wrong answers is displayed <strong>ONLY ONCE</strong> upon completing your assessment. Once you leave this page, only your total score will be saved in your profile.</div>
        </div>

        <h3 style="font-size: 1.2rem; color: var(--primary-dark); margin-bottom: 16px; border-bottom: 2px solid var(--border-color); padding-bottom: 8px;">
          📋 Immediate Question &amp; Answer Review
        </h3>
      `;

      qList.forEach((q, idx) => {
        const isCorr = q.isCorrect;
        html += `
          <div style="background: ${isCorr ? '#F0FDF4' : '#FEF2F2'}; border: 1px solid ${isCorr ? '#BBF7D0' : '#FCA5A5'}; border-radius: 8px; padding: 14px; margin-bottom: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-weight: 700; font-size: 0.85rem; color: var(--text-muted);">Q${idx + 1}. [${q.category}]</span>
              <span style="font-weight: 800; padding: 3px 10px; border-radius: 12px; font-size: 0.78rem; background: ${isCorr ? '#DCFCE7' : '#FEE2E2'}; color: ${isCorr ? '#15803D' : '#B91C1C'};">
                ${isCorr ? '✔ Correct Answer' : '✖ Incorrect Answer'}
              </span>
            </div>
            <div style="font-size: 0.95rem; font-weight: 700; color: var(--primary-dark); margin-bottom: 10px;">${q.question}</div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.85rem;">
              <div style="background: ${isCorr ? '#DCFCE7' : '#FEE2E2'}; border: 1px solid ${isCorr ? '#86EFAC' : '#FCA5A5'}; padding: 8px 12px; border-radius: 6px; color: ${isCorr ? '#166534' : '#991B1B'};">
                <strong>Your Choice:</strong> [${q.selectedKey}] ${q.selectedText}
              </div>
              <div style="background: #FFFFFF; border: 1px solid #CBD5E1; padding: 8px 12px; border-radius: 6px; color: #1E293B;">
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
  const allEmps = EMPLOYEES;

  let completedCount = 0;
  let inProgressCount = 0;

  allEmps.forEach(emp => {
    const rec = records[emp.empNo];
    if (rec && rec.isCompleted) completedCount++;
    else if (rec && rec.inProgress) inProgressCount++;
  });

  const notStartedCount = allEmps.length - completedCount - inProgressCount;

  document.getElementById('statTotalEmp').innerText = allEmps.length;
  document.getElementById('statCompleted').innerText = completedCount;
  document.getElementById('statInProgress').innerText = inProgressCount;
  document.getElementById('statNotStarted').innerText = notStartedCount;

  renderPieChart(completedCount, inProgressCount, notStartedCount);
  renderBarChart(records);
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
  document.getElementById('modalAddEditQuestion').style.display = 'flex';
}

function openEditQuestionModal(qId) {
  let targetQ = null;
  ['L', 'U', 'O'].forEach(lvl => {
    const found = (QUESTION_BANK[lvl] || []).find(q => q.id === qId);
    if (found) targetQ = found;
  });

  if (!targetQ) return showToast('Question not found');

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

  document.getElementById('modalAddEditQuestion').style.display = 'flex';
}

function closeQModal() {
  document.getElementById('modalAddEditQuestion').style.display = 'none';
}

function saveQuestionFromModal(e) {
  e.preventDefault();
  const qId = document.getElementById('qEditId').value;
  const level = document.getElementById('modalQLevel').value;
  const section = document.getElementById('modalQSection').value;
  const category = document.getElementById('modalQCategory').value;
  const qText = document.getElementById('modalQText').value.trim();

  const optA = document.getElementById('modalOptA').value.trim();
  const optB = document.getElementById('modalOptB').value.trim();
  const optC = document.getElementById('modalOptC').value.trim();
  const optD = document.getElementById('modalOptD').value.trim();
  const correctAnswer = document.getElementById('modalQCorrect').value;

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
    // Edit existing
    ['L', 'U', 'O'].forEach(lvl => {
      const idx = (QUESTION_BANK[lvl] || []).findIndex(q => q.id === qId);
      if (idx !== -1) QUESTION_BANK[lvl].splice(idx, 1);
    });
    QUESTION_BANK[level].push(newQ);
    showToast('Question updated successfully! ✏️');
  } else {
    // Add new
    QUESTION_BANK[level].push(newQ);
    showToast('New question added successfully! ➕');
  }

  saveCustomQuestionsToServer();
  closeQModal();
  renderQuestionsManager();
}

function deleteQuestion(qId) {
  if (!confirm('Are you sure you want to delete this question?')) return;

  ['L', 'U', 'O'].forEach(lvl => {
    const idx = (QUESTION_BANK[lvl] || []).findIndex(q => q.id === qId);
    if (idx !== -1) {
      QUESTION_BANK[lvl].splice(idx, 1);
    }
  });

  saveCustomQuestionsToServer();
  showToast('Question deleted successfully 🗑️');
  renderQuestionsManager();
}

// Cloud Sync for Employees & Security Settings
async function syncCloudEmployees() {
  try {
    const res = await fetch('/api/employees');
    const data = await res.json();
    if (data.success && data.employees && Array.isArray(data.employees) && data.employees.length > 0) {
      EMPLOYEES.length = 0;
      EMPLOYEES.push(...data.employees);
      if (document.getElementById('empDirectoryTbody')) {
        renderEmployeeDirectory();
      }
    }
  } catch (e) {}
}

function saveCustomEmployeesToServer() {
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
      showToast('Security Settings saved & updated in Cloud DB! ⚙️');
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
  document.getElementById('modalAddEditEmployee').style.display = 'flex';
}

function openEditEmpModal(empNo) {
  const emp = EMPLOYEES.find(e => e.empNo === empNo);
  if (!emp) return;
  document.getElementById('modalEmpTitle').innerText = `✏️ Edit Employee (${empNo})`;
  document.getElementById('empIsEdit').value = 'true';
  document.getElementById('empOldNo').value = empNo;
  document.getElementById('modalEmpNo').value = emp.empNo;
  document.getElementById('modalEmpNo').disabled = true;
  document.getElementById('modalEmpName').value = emp.name;
  document.getElementById('modalEmpDept').value = emp.dept || 'Quality Control';
  document.getElementById('modalEmpSection').value = emp.section || 'Final Finish QA';
  document.getElementById('modalEmpDoj').value = emp.doj || '';
  document.getElementById('modalEmpLevel').value = emp.currentLevel || 'I';
  document.getElementById('modalAddEditEmployee').style.display = 'flex';
}

function closeEmpModal() {
  document.getElementById('modalAddEditEmployee').style.display = 'none';
}

function saveEmployeeFromModal(e) {
  e.preventDefault();
  const isEdit = document.getElementById('empIsEdit').value === 'true';
  const oldNo = document.getElementById('empOldNo').value;
  const empNo = document.getElementById('modalEmpNo').value.trim();
  const name = document.getElementById('modalEmpName').value.trim();
  const dept = document.getElementById('modalEmpDept').value.trim();
  const section = document.getElementById('modalEmpSection').value;
  const doj = document.getElementById('modalEmpDoj').value.trim();
  const level = document.getElementById('modalEmpLevel').value;

  if (!isEdit && EMPLOYEES.some(e => e.empNo === empNo)) {
    alert(`Employee ID '${empNo}' already exists in the directory! Please use a unique Employee ID.`);
    return;
  }

  if (isEdit) {
    const idx = EMPLOYEES.findIndex(e => e.empNo === oldNo);
    if (idx !== -1) {
      EMPLOYEES[idx] = { empNo, name, dept, section, doj, currentLevel: level };
      showToast(`Employee ${empNo} updated successfully! ✏️`);
    }
  } else {
    EMPLOYEES.unshift({ empNo, name, dept, section, doj, currentLevel: level });
    showToast(`New Employee ${empNo} (${name}) added! ➕`);
  }

  saveCustomEmployeesToServer();
  closeEmpModal();
  renderEmployeeDirectory();
}

function deleteEmployee(empNo) {
  if (!confirm(`Are you sure you want to delete Employee ${empNo} from the directory?`)) return;
  const idx = EMPLOYEES.findIndex(e => e.empNo === empNo);
  if (idx !== -1) {
    EMPLOYEES.splice(idx, 1);
    saveCustomEmployeesToServer();
    showToast(`Employee ${empNo} deleted from Directory 🗑️`);
    renderEmployeeDirectory();
  }
}

// Results Database Table & Reset Action
function renderAdminTable(query) {
  const records = getStoredRecords();
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

    const tr = document.createElement('tr');

    const statusBadge = rec.isCompleted
      ? `<span class="${rec.status && rec.status.includes('Terminated') ? 'badge-fail' : 'badge-pass'}">${rec.status || 'Completed'}</span>`
      : rec.inProgress
      ? `<span class="badge-pending">In Progress (${rec.tabSwitchCount || 0} Sw)</span>`
      : `<span style="color: #94A3B8;">Not Started</span>`;

    const hasRecord = rec.isCompleted || rec.inProgress;
    const actionBtn = hasRecord
      ? `<div style="display: flex; gap: 6px; flex-wrap: wrap;">
           <button class="btn-primary" style="padding: 4px 10px; font-size: 0.78rem; background: #0284C7; border-color: #0284C7;" onclick="downloadEmployeePDF('${emp.empNo}')">📄 PDF Report</button>
           <button class="btn-reset" style="padding: 4px 10px; font-size: 0.78rem;" onclick="confirmAndResetExam('${emp.empNo}', '${emp.name.replace(/'/g, "\\'")}')">🔄 Reset</button>
         </div>`
      : `<span style="color: #CBD5E1; font-size: 0.8rem;">No attempt</span>`;

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
      <td>${rec.markPct !== undefined ? rec.markPct + '%' : '-'}</td>
      <td>${statusBadge}</td>
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
  const emp = EMPLOYEES.find(e => e.empNo === empNo);

  const empName = emp ? emp.name : (rec.name || empNo);
  const empDept = emp ? emp.dept : (rec.dept || 'QUALITY CONTROL');
  const empSection = emp ? (emp.section || rec.section || '-') : (rec.section || '-');
  const empDoj = emp ? (emp.doj || rec.doj || '-') : (rec.doj || '-');
  const level = rec.targetLevel || (emp ? emp.currentLevel : 'O') || 'O';
  const isAttempted = !!(rec.isCompleted || rec.inProgress);
  const status = isAttempted ? (rec.status || (rec.isCompleted ? 'Completed' : 'In Progress')) : 'Not Attempted';
  const isPass = status === 'Passed';

  // Build question list for PDF
  let qList = rec.submittedQuestions || [];
  
  if (qList.length === 0 && rec.responses) {
    const matchedQs = getQuestionsForSection(level, empSection);
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

  const reportDiv = document.createElement('div');
  reportDiv.id = 'pdfReportTempContainer';
  reportDiv.style.padding = '24px';
  reportDiv.style.fontFamily = 'Arial, sans-serif';
  reportDiv.style.color = '#1E293B';
  reportDiv.style.background = '#FFFFFF';
  reportDiv.style.maxWidth = '800px';
  reportDiv.style.margin = '0 auto';

  const badgeBg = isPass ? '#DCFCE7' : (!isAttempted ? '#F1F5F9' : '#FEE2E2');
  const badgeColor = isPass ? '#166534' : (!isAttempted ? '#475569' : '#991B1B');

  reportDiv.innerHTML = `
    <!-- Header -->
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #005B9E; padding-bottom: 12px; margin-bottom: 20px;">
      <div>
        <div style="font-size: 22px; font-weight: 800; color: #005B9E; letter-spacing: 0.5px;">YOKOHAMA OFF-HIGHWAY TIRES</div>
        <div style="font-size: 13px; font-weight: 600; color: #64748B;">QUALITY ASSURANCE DEPARTMENT &mdash; ILUO ASSESSMENT REPORT</div>
      </div>
      <div style="text-align: right;">
        <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 6px 16px; border-radius: 20px; font-weight: 800; font-size: 14px; text-transform: uppercase;">
          ${status}
        </span>
      </div>
    </div>

    <!-- Employee Details Table -->
    <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
        <div><strong>Employee No:</strong> <span style="color: #005B9E; font-weight: 700;">${empNo}</span></div>
        <div><strong>Employee Name:</strong> ${empName}</div>
        <div><strong>Department:</strong> ${empDept}</div>
        <div><strong>Section:</strong> ${empSection}</div>
        <div><strong>Date of Joining (DOJ):</strong> ${empDoj}</div>
        <div><strong>Assessment Date:</strong> ${rec.attemptDate || new Date().toLocaleDateString('en-GB')}</div>
        <div><strong>Target Skill Level:</strong> ${level} Level Assessment</div>
        <div><strong>Tab Switch Alerts:</strong> <span style="color: ${(rec.tabSwitchCount || 0) > 0 ? '#E31B23' : '#166534'}; font-weight: 700;">${rec.tabSwitchCount || 0} Warnings</span></div>
      </div>
    </div>

    <!-- Scorecard Summary Box -->
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; text-align: center;">
      <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 14px; border-radius: 8px;">
        <div style="font-size: 11px; color: #1E40AF; text-transform: uppercase; font-weight: 700;">Total Score</div>
        <div style="font-size: 24px; font-weight: 800; color: #1E3A8A; margin-top: 4px;">${rec.totalMark !== undefined ? rec.totalMark : (isAttempted ? 0 : '-')} / ${qList.length > 0 ? qList.length : 30}</div>
      </div>
      <div style="background: #F0FDF4; border: 1px solid #BBF7D0; padding: 14px; border-radius: 8px;">
        <div style="font-size: 11px; color: #166534; text-transform: uppercase; font-weight: 700;">Percentage Mark</div>
        <div style="font-size: 24px; font-weight: 800; color: #14532D; margin-top: 4px;">${rec.markPct !== undefined ? rec.markPct + '%' : (isAttempted ? '0%' : '-')}</div>
      </div>
      <div style="background: #FFFBEB; border: 1px solid #FDE68A; padding: 14px; border-radius: 8px;">
        <div style="font-size: 11px; color: #92400E; text-transform: uppercase; font-weight: 700;">Passing Criteria</div>
        <div style="font-size: 24px; font-weight: 800; color: #78350F; margin-top: 4px;">70%</div>
      </div>
    </div>

    <!-- Question & Answer Audit Sheet -->
    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 15px; border-bottom: 2px solid #E2E8F0; padding-bottom: 6px; margin-bottom: 14px; color: #0F172A;">
        Assessment Audit Breakdown
      </h3>

      ${qList.length > 0 ? qList.map((q, idx) => `
        <div style="margin-bottom: 14px; padding: 12px; border: 1px solid ${q.isCorrect ? '#CBD5E1' : '#FCA5A5'}; border-radius: 6px; background: ${q.isCorrect ? '#FFFFFF' : '#FFF5F5'}; font-size: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-weight: 700; color: #334155;">Q${idx + 1}. [${q.category}]</span>
            <span style="font-weight: 700; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: ${q.isCorrect ? '#DCFCE7' : '#FEE2E2'}; color: ${q.isCorrect ? '#15803D' : '#B91C1C'};">
              ${q.isCorrect ? 'Correct' : 'Incorrect'}
            </span>
          </div>
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #0F172A;">${q.question}</div>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
            <div style="background: ${q.isCorrect ? '#DCFCE7' : '#FEE2E2'}; border: 1px solid ${q.isCorrect ? '#86EFAC' : '#FCA5A5'}; padding: 6px 10px; border-radius: 4px;">
              <strong>Employee Selected:</strong> [${q.selectedKey}] ${q.selectedText}
            </div>
            <div style="background: #F1F5F9; border: 1px solid #CBD5E1; padding: 6px 10px; border-radius: 4px;">
              <strong>Correct Key:</strong> [${q.correctKey}] ${q.correctText}
            </div>
          </div>
        </div>
      `).join('') : `
        <div style="padding: 16px; border: 1px dashed #CBD5E1; border-radius: 6px; background: #F8FAFC; text-align: center; color: #64748B; font-size: 13px;">
          Assessment has not been completed by the candidate yet. Question and response audit will appear once submitted.
        </div>
      `}
    </div>

    <!-- Signatures -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; padding-top: 20px; border-top: 1px solid #CBD5E1; font-size: 12px; text-align: center;">
      <div>
        <div style="margin-bottom: 40px; border-bottom: 1px dashed #94A3B8; width: 80%; margin: 0 auto 8px auto;"></div>
        <div><strong>Evaluator / Supervisor Signature</strong></div>
      </div>
      <div>
        <div style="margin-bottom: 40px; border-bottom: 1px dashed #94A3B8; width: 80%; margin: 0 auto 8px auto;"></div>
        <div><strong>Quality Control Manager Stamp &amp; Date</strong></div>
      </div>
    </div>
  `;

  document.body.appendChild(reportDiv);

  showToast(`Generating PDF report for ${empNo}...`);

  if (typeof html2pdf !== 'undefined') {
    const opt = {
      margin: [10, 10, 10, 10],
      filename: `Yokohama_ILUO_Report_${empNo}_${empName.replace(/\s+/g, '_')}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(reportDiv).save().then(() => {
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

  let completedCount = 0;
  let passCount = 0;

  allEmps.forEach(emp => {
    const rec = records[emp.empNo];
    if (rec && rec.isCompleted) {
      completedCount++;
      if (rec.status === 'Passed' || (rec.markPct !== undefined && rec.markPct >= 70)) {
        passCount++;
      }
    }
  });

  const passRate = completedCount > 0 ? Math.round((passCount / completedCount) * 100) : 0;

  const elTotalEmps = document.getElementById('reportMetricTotalEmps');
  if (elTotalEmps) elTotalEmps.innerText = allEmps.length;

  const elCompleted = document.getElementById('reportMetricCompleted');
  if (elCompleted) elCompleted.innerText = completedCount;

  const elPassRate = document.getElementById('reportMetricPassRate');
  if (elPassRate) elPassRate.innerText = `Pass Rate: ${passRate}% (${passCount} Passed)`;

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
  return EMPLOYEES.map((emp, index) => {
    const rec = records[emp.empNo] || {};
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
      "Percentage": rec.markPct !== undefined ? rec.markPct + "%" : "0%",
      "Tab Switches": rec.tabSwitchCount || 0,
      "Status": rec.status || (rec.inProgress ? "In Progress" : "Not Started"),
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

// Bulk Clear & Docx Upload Parser
function clearAllQuestions() {
  if (!confirm('⚠️ WARNING: Are you sure you want to DELETE ALL QUESTIONS?\n\nThis will clear the entire question bank. You can then upload your own custom .docx files!')) return;

  QUESTION_BANK.L = [];
  QUESTION_BANK.U = [];
  QUESTION_BANK.O = [];

  saveCustomQuestionsToServer();
  showToast('All questions deleted! Bank is now empty 🗑️');
  renderQuestionsManager();
}

function handleDocxUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.name.endsWith('.docx')) {
    alert('Please select a valid Word Document (.docx) file.');
    return;
  }

  const filename = file.name;
  let level_code = 'O';
  if (filename.includes('L Level') || filename.includes('L_Level') || filename.startsWith('L ')) level_code = 'L';
  else if (filename.includes('U Level') || filename.includes('U_Level') || filename.startsWith('U ')) level_code = 'U';
  else if (filename.includes('O Level') || filename.includes('O_Level') || filename.startsWith('O ')) level_code = 'O';

  let section_name = 'Final Finish QA';
  if (filename.includes('Final Finish QA')) section_name = 'Final Finish QA';
  else if (filename.includes('Tire Building')) section_name = 'Tire Building QA';
  else if (filename.includes('Tire Curing')) section_name = 'Tire Curing QA';
  else if (filename.includes('Solid Tire')) section_name = 'Solid Tire QA';
  else if (filename.includes('Preparatory')) section_name = 'Preparatory QA';
  else if (filename.includes('Warehouse')) section_name = 'Warehouse QA';
  else if (filename.includes('FID Inspector')) section_name = 'FID Inspector QA';
  else if (filename.includes('RRO') || filename.includes('ALT')) section_name = 'Final Finish RRO & ALT QA';

  const reader = new FileReader();
  reader.onload = function(e) {
    const arrayBuffer = e.target.result;
    if (typeof mammoth === 'undefined') {
      alert('Mammoth.js library loading... Please try again in a moment.');
      return;
    }

    mammoth.extractRawText({ arrayBuffer: arrayBuffer })
      .then(function(result) {
        const text = result.value;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let current_cat = 'Safety';
        let parsed_qs = [];
        let i = 0;

        while (i < lines.length) {
          const line = lines[i];
          const l_upper = line.toUpperCase();

          if (l_upper.includes('SAFETY')) { current_cat = 'Safety'; i++; continue; }
          if (l_upper.includes('CI & TPM') || l_upper.includes('TPM')) { current_cat = 'CI & TPM'; i++; continue; }
          if (l_upper.includes('PROCESS') || l_upper.includes('QUALITY') || l_upper.includes('QA')) { current_cat = 'QA & Process'; i++; continue; }

          if (line.startsWith('Assessment Questionnaire') || line.startsWith('Marks Classification:')) { i++; continue; }

          // Options check
          let opts = [];
          let j = i + 1;
          while (j < lines.length && j <= i + 4) {
            const next_line = lines[j];
            const is_opt = /^([a-d1-4])[\.\)]\s*(.*)/i.test(next_line);
            if (is_opt) {
              const match = next_line.match(/^([a-d1-4])[\.\)]\s*(.*)/i);
              const keys = ['A', 'B', 'C', 'D'];
              opts.push({ key: keys[opts.length] || 'A', text: match ? match[2] : next_line });
              j++;
            } else {
              break;
            }
          }

          if (opts.length >= 2) {
            parsed_qs.push({
              id: `${level_code}_${section_name.replace(/\s+/g, '_')}_${parsed_qs.length + 1}`,
              level: level_code,
              section: section_name,
              category: current_cat,
              question: line,
              options: opts,
              correctAnswer: 'A'
            });
            i = j;
            continue;
          }
          i++;
        }

        if (parsed_qs.length === 0) {
          alert(`Could not extract questions from '${filename}'. Make sure options are formatted as a. b. c. d.`);
          return;
        }

        if (!QUESTION_BANK[level_code]) QUESTION_BANK[level_code] = [];
        QUESTION_BANK[level_code].push(...parsed_qs);

        saveCustomQuestionsToServer();
        showToast(`🎉 Successfully imported ${parsed_qs.length} questions from ${filename}!`);
        renderQuestionsManager();
      })
      .catch(function(err) {
        alert('Error parsing docx file: ' + err.message);
      });
  };

  reader.readAsArrayBuffer(file);
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
    const actionBtn = hasRecord
      ? `<div style="display: flex; gap: 6px; flex-wrap: wrap;">
           <button class="btn-primary" style="padding: 3px 8px; font-size: 0.75rem; background: #0284C7; border-color: #0284C7;" onclick="downloadEmployeePDF('${emp.empNo}')">PDF</button>
           <button class="btn-reset" style="padding: 3px 8px; font-size: 0.75rem;" onclick="confirmAndResetExam('${emp.empNo}', '${emp.name.replace(/'/g, "\\'")}')">Reset</button>
         </div>`
      : `<span style="color: #CBD5E1; font-size: 0.78rem;">No attempt</span>`;

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
      <td><strong>${rec.markPct !== undefined ? rec.markPct + '%' : '-'}</strong></td>
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
  const empSheetData = sectionEmps.length > 0 ? sectionEmps.map((emp, index) => {
    const rec = records[emp.empNo] || {};
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
      "Percentage": rec.markPct !== undefined ? rec.markPct + "%" : "0%",
      "Tab Switches": rec.tabSwitchCount || 0,
      "Status": rec.status || (rec.inProgress ? "In Progress" : "Not Started"),
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

function computeEmployeeTrainingNeed(emp, rec, trainingRec) {
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

  if (rec && (rec.status === 'Failed' || (rec.markPct !== undefined && rec.markPct < 70) || (rec.tabSwitchCount && rec.tabSwitchCount > 3))) {
    priority = 'CRITICAL';
    targetLevel = `Retest (${rec.targetLevel || currLevel})`;
    finding = `Scored ${rec.markPct !== undefined ? rec.markPct + '%' : 'Failed'} (<70% standard) - Needs Refresher & Retest`;
    assignedModule = modules[1] || modules[0];
  } else if (rec && (rec.status === 'Passed' || (rec.markPct !== undefined && rec.markPct >= 70))) {
    priority = 'PROGRESSION';
    if (currLevel === 'I') targetLevel = 'L Level (Basic Operator)';
    else if (currLevel === 'L') targetLevel = 'U Level (Independent Skilled)';
    else if (currLevel === 'U') targetLevel = 'O Level (Supervisor / Evaluator)';
    else targetLevel = 'Master Trainer (ILUO Lead)';

    finding = `Passed ${rec.targetLevel || currLevel} with ${rec.markPct}% - Eligible for Next Level Advancement`;
    assignedModule = modules[2] || modules[0];
  } else {
    // Not yet attempted
    if (currLevel === 'I') {
      priority = 'PROGRESSION';
      targetLevel = 'L Level (Basic)';
      finding = 'Learner (I Level) - Foundational Operator Qualification Training required';
      assignedModule = modules[0];
    } else if (currLevel === 'L') {
      priority = 'PROGRESSION';
      targetLevel = 'U Level (Independent)';
      finding = 'Supervised Operator (L Level) - Eligible for Independent Skilled qualification';
      assignedModule = modules[1] || modules[0];
    } else if (currLevel === 'U') {
      priority = 'PROGRESSION';
      targetLevel = 'O Level (Evaluator)';
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
    priority, // CRITICAL | PROGRESSION | REFRESHER
    finding,
    assignedModule,
    status, // PENDING | SCHEDULED | COMPLETED
    scheduledDate
  };
}

function getAllTrainingDataset() {
  const records = getStoredRecords();
  const trainingRecords = getStoredTrainingRecords();

  return EMPLOYEES.map(emp => {
    const rec = records[emp.empNo];
    const trainingRec = trainingRecords[emp.empNo];
    return computeEmployeeTrainingNeed(emp, rec, trainingRec);
  });
}

function renderTrainingRequirements() {
  const dataset = getAllTrainingDataset();

  // Compute Metrics
  let criticalCount = 0;
  let progressionCount = 0;
  let scheduledCount = 0;

  dataset.forEach(item => {
    if (item.priority === 'CRITICAL') criticalCount++;
    if (item.priority === 'PROGRESSION') progressionCount++;
    if (item.status === 'SCHEDULED' || item.status === 'COMPLETED') scheduledCount++;
  });

  const elTotal = document.getElementById('trainingMetricTotal');
  if (elTotal) elTotal.innerText = dataset.length;

  const elCrit = document.getElementById('trainingMetricCritical');
  if (elCrit) elCrit.innerText = criticalCount;

  const elProg = document.getElementById('trainingMetricProgression');
  if (elProg) elProg.innerText = progressionCount;

  const elSched = document.getElementById('trainingMetricScheduled');
  if (elSched) elSched.innerText = scheduledCount;

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
        <td colspan="11" style="text-align: center; padding: 36px; color: var(--text-muted);">
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
    showToast('Downloaded Training Plan as CSV.');
  }
}

