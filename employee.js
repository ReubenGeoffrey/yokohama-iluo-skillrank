let clientCsrfToken = '';

async function initCsrfToken() {
  try {
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    const data = await res.json();
    if (data && data.csrfToken) {
      clientCsrfToken = data.csrfToken;
    }
  } catch (e) {}
}
if (typeof window !== 'undefined') {
  initCsrfToken();
}

function getCsrfToken() {
  if (clientCsrfToken) return clientCsrfToken;
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function getAuthHeaders(extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const csrf = getCsrfToken();
  if (csrf) headers['x-csrf-token'] = csrf;
  if (typeof empState !== 'undefined' && empState && empState.token) {
    headers['x-emp-token'] = empState.token;
  }
  return headers;
}

/**
 * Yokohama ILUO - Dedicated Employee Portal Controller
 * Authoritative single-source API client for employee assessments, roadmap & certificates
 */

const STORAGE_KEY_EMP_SESSION = 'yokohama_emp_session';
const STORAGE_KEY_OFFLINE_QUEUE = 'yokohama_offline_exam_queue';
const STORAGE_KEY_LANG = 'yokohama_portal_lang';
const STORAGE_KEY_THEME = 'yokohama_portal_theme';

let empSettings = {
  examPassingPct: 50,
  ojtPassingPct: 70,
  examDurationMinutes: 45,
  maxTabSwitches: 3,
  tabSwitchAction: 'terminate'
};

let empLang = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_LANG)) || 'en';
let empTheme = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_THEME)) || 'light';

const EMP_I18N = {
  en: {
    portalSubtitle: 'Employee Skill Assessment Portal',
    signOut: 'Sign Out',
    empPortalHeading: 'Employee Portal',
    empPortalLead: 'Sign in with your Employee Number to access your skill roadmap, exams & certificate',
    employeeIdLabel: 'Employee Number',
    passwordLabel: 'Password',
    defaultPasswordHint: 'Default login: Username and Password are your Employee Number.',
    signInBtn: 'Sign In to Employee Portal',
    backToHub: '← Back to Portal Hub',
    metaEmpId: 'Employee ID',
    metaDoj: 'Date of Joining',
    metaDue: 'Re-Assessment Due',
    currentLevelLabel: 'CURRENT LEVEL',
    assignedAssessment: 'ASSIGNED ASSESSMENT',
    knowledgeTestTitle: 'Knowledge Test Assessment',
    startExamBtn: 'Start Assessment »',
    viewCertBtn: 'View QR Certificate',
    roadmapTitle: 'ILUO Skill Qualification Roadmap',
    roadmapSubtitle: 'Progression milestones across I (Grey) → L (Amber) → U (Blue) → O (Green)',
    historyTitle: 'Assessment Attempt History',
    historySubtitle: 'Recorded MCQ exam attempts & practical OJT evaluation status'
  },
  ta: {
    portalSubtitle: 'ஊழியர் திறன் மதிப்பீட்டு தளம்',
    signOut: 'வெளியேறு',
    empPortalHeading: 'ஊழியர் தளம்',
    empPortalLead: 'உங்கள் ஊழியர் எண்ணைக் கொண்டு உள்நுழையவும்',
    employeeIdLabel: 'ஊழியர் எண் (பயனர் பெயர்)',
    passwordLabel: 'கடவுச்சொல்',
    defaultPasswordHint: 'இயல்புநிலை உள்நுழைவு: பயனர் பெயர் மற்றும் கடவுச்சொல் இரண்டும் உங்கள் ஊழியர் எண்.',
    signInBtn: 'ஊழியர் தளத்தில் உள்நுழையவும்',
    backToHub: '← முகப்புக்குத் திரும்பு',
    metaEmpId: 'ஊழியர் எண்',
    metaDoj: 'சேர்ந்த தேதி',
    metaDue: 'மறுமதிப்பீட்டு தேதி',
    currentLevelLabel: 'தற்போதைய நிலை',
    assignedAssessment: 'ஒதுக்கப்பட்ட தேர்வு',
    knowledgeTestTitle: 'தொழில்நுட்ப அறிவுத் தேர்வு',
    startExamBtn: 'தேர்வைத் தொடங்கு »',
    viewCertBtn: 'QR சான்றிதழ் காண்க',
    roadmapTitle: 'ILUO திறன் தகுதி பாதை',
    roadmapSubtitle: 'I (சாம்பல்) → L (மஞ்சள்) → U (நீலம்) → O (பச்சை) நிலைகள்',
    historyTitle: 'தேர்வு முயற்சி வரலாறு',
    historySubtitle: 'பதிவு செய்யப்பட்ட தேர்வு மதிப்பெண்கள் மற்றும் OJT நிலை'
  }
};

let empState = {
  employee: null,
  token: null,
  exam: null,
  examQuestions: [],
  currentQIndex: 0,
  userAnswers: {},
  examTimerInterval: null,
  timeRemainingSec: 2700,
  tabSwitches: 0,
  isSubmitting: false
};

function escapeEmpHtml(val) {
  if (typeof window !== 'undefined' && window.ILUO_CONSTANTS && typeof window.ILUO_CONSTANTS.escapeHtml === 'function') {
    return window.ILUO_CONSTANTS.escapeHtml(val);
  }
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getExamPassPct() {
  return Number(empSettings.examPassingPct || 50);
}

function getOjtPassPct() {
  return Number(empSettings.ojtPassingPct || 70);
}

function getMaxTabSwitches() {
  return Number(empSettings.maxTabSwitches || 3);
}

async function loadEmpPublicSettings() {
  try {
    const res = await fetch('/api/public-settings', { credentials: 'include' });
    const data = await res.json();
    if (data && data.success && data.settings) {
      empSettings = { ...empSettings, ...data.settings };
      setText('dashExamDuration', `${empSettings.examDurationMinutes || 45} Minutes`);
      setText('dashExamPassThresholds', `Exam ${getExamPassPct()}% / OJT ${getOjtPassPct()}%`);
    }
  } catch (e) {}
}

function applyEmployeeTheme(theme) {
  empTheme = (theme === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', empTheme);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY_THEME, empTheme);
  const btn = document.getElementById('empBtnToggleTheme');
  if (btn) btn.innerText = empTheme === 'dark' ? 'Light' : 'Dark';
}

function toggleEmployeeTheme() {
  applyEmployeeTheme(empTheme === 'dark' ? 'light' : 'dark');
}
window.toggleEmployeeTheme = toggleEmployeeTheme;

function applyEmployeeLanguage(lang) {
  empLang = (lang === 'ta') ? 'ta' : 'en';
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY_LANG, empLang);
  document.body.classList.toggle('lang-ta', empLang === 'ta');
  const dict = EMP_I18N[empLang] || EMP_I18N.en;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && dict[key]) el.innerText = dict[key];
  });
  const btn = document.getElementById('empBtnToggleLang');
  if (btn) btn.innerText = empLang === 'ta' ? 'தமிழ் / EN' : 'EN / தமிழ்';
}

function toggleEmployeeLanguage() {
  applyEmployeeLanguage(empLang === 'en' ? 'ta' : 'en');
}
window.toggleEmployeeLanguage = toggleEmployeeLanguage;

// DOM ready initialization
document.addEventListener('DOMContentLoaded', () => {
  applyEmployeeTheme(empTheme);
  applyEmployeeLanguage(empLang);
  loadEmpPublicSettings();
  setupTabSwitchDetection();
  setupQuizAntiCheatListeners();
  setupOfflineSyncListeners();
  updateEmployeeNav();
  checkExistingSession();
});

function isQuizViewActive() {
  const viewQuiz = document.getElementById('viewQuiz');
  return Boolean(viewQuiz && viewQuiz.style.display !== 'none' && empState.examTimerInterval);
}

// Scoped copy/paste/contextmenu protection ONLY on active quiz page
function setupQuizAntiCheatListeners() {
  const blockIfQuiz = (e) => {
    if (isQuizViewActive()) {
      e.preventDefault();
    }
  };
  document.addEventListener('copy', blockIfQuiz);
  document.addEventListener('cut', blockIfQuiz);
  document.addEventListener('paste', blockIfQuiz);
  document.addEventListener('contextmenu', blockIfQuiz);
  document.addEventListener('keydown', (e) => {
    if (!isQuizViewActive()) return;
    if ((e.ctrlKey || e.metaKey) && ['c', 'u', 's', 'p', 'a'].includes(String(e.key || '').toLowerCase())) {
      e.preventDefault();
    }
    if (e.key === 'F12') {
      e.preventDefault();
    }
  });
}

// Navigation helper between views
function showEmployeeView(viewId) {
  const views = ['viewEmpLogin', 'viewEmpDashboard', 'viewQuiz', 'viewResult'];
  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = (id === viewId) ? 'block' : 'none';
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Password toggle helper
function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';

  if (btn) {
    btn.innerHTML = isPass
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  }
}
window.togglePasswordVisibility = togglePasswordVisibility;

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('empToastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.style.padding = '12px 18px';
  toast.style.borderRadius = '8px';
  toast.style.fontSize = '0.88rem';
  toast.style.fontWeight = '600';
  toast.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
  toast.style.color = '#FFFFFF';
  toast.style.maxWidth = '360px';
  toast.style.pointerEvents = 'auto';

  if (type === 'error') toast.style.background = '#DC2626';
  else if (type === 'success') toast.style.background = '#15803D';
  else toast.style.background = '#0F172A';

  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Check session on load
async function checkExistingSession() {
  const saved = localStorage.getItem(STORAGE_KEY_EMP_SESSION);
  if (!saved) {
    updateEmployeeNav();
    showEmployeeView('viewEmpLogin');
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !parsed.token || !parsed.empNo) {
      updateEmployeeNav();
      showEmployeeView('viewEmpLogin');
      return;
    }

    const res = await fetch('/api/auth/employee/me', {
      headers: getAuthHeaders({ 'x-emp-token': parsed.token }),
      credentials: 'include'
    });

    const data = await res.json();
    if (data.authenticated && data.employee) {
      empState.employee = data.employee;
      empState.token = parsed.token;
      updateEmployeeNav();
      await loadEmployeeDashboard();
      await flushOfflineExamQueue();
      showEmployeeView('viewEmpDashboard');
    } else {
      localStorage.removeItem(STORAGE_KEY_EMP_SESSION);
      updateEmployeeNav();
      showEmployeeView('viewEmpLogin');
    }
  } catch (err) {
    console.error('Session verify error:', err);
    updateEmployeeNav();
    showEmployeeView('viewEmpLogin');
  }
}

// Update top nav user badge (strictly hidden & cleared when signed out)
function updateEmployeeNav() {
  const badge = document.getElementById('empNavUserBadge');
  const nameEl = document.getElementById('empNavUserName');
  const noEl = document.getElementById('empNavEmpNo');
  const btnSignOut = document.getElementById('btnEmpSignOut');

  if (empState.employee) {
    if (badge) badge.style.display = 'flex';
    if (nameEl) nameEl.innerText = empState.employee.name || 'Candidate';
    if (noEl) noEl.innerText = `(${empState.employee.empNo})`;
    if (btnSignOut) btnSignOut.style.display = 'inline-block';
  } else {
    if (badge) badge.style.display = 'none';
    if (nameEl) nameEl.innerText = '';
    if (noEl) noEl.innerText = '';
    if (btnSignOut) btnSignOut.style.display = 'none';
  }
}

// Handle Employee Login (Username: Employee Number, Default Password: Employee Number)
async function handleEmployeeLogin(e) {
  if (e) e.preventDefault();
  const empIdInput = document.getElementById('empIdInput');
  const empPasswordInput = document.getElementById('empPasswordInput');
  const submitBtn = document.getElementById('btnEmpLoginSubmit');

  const empNo = empIdInput ? empIdInput.value.trim() : '';
  const password = empPasswordInput ? empPasswordInput.value.trim() : '';

  if (!empNo || !password) {
    showToast('Please enter your Employee Number and password.', 'error');
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/auth/employee/login', {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ empNo, password })
    });

    const data = await res.json();

    if (data.success && data.token) {
      await completeEmployeeSignIn(data.employee, data.token, `Welcome, ${data.employee.name}!`);
    } else {
      showToast(data.message || 'Invalid Employee Number or password.', 'error');
    }
  } catch (err) {
    console.error('Login error:', err);
    showToast('Unable to connect to authentication server.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
window.handleEmployeeLogin = handleEmployeeLogin;

async function completeEmployeeSignIn(employee, token, welcomeMsg) {
  empState.employee = employee;
  empState.token = token;

  localStorage.setItem(STORAGE_KEY_EMP_SESSION, JSON.stringify({
    token,
    empNo: employee.empNo,
    name: employee.name
  }));

  updateEmployeeNav();
  showToast(welcomeMsg || `Welcome, ${employee.name}!`, 'success');
  await loadEmployeeDashboard();
  await flushOfflineExamQueue();
  showEmployeeView('viewEmpDashboard');
}

// Handle Employee Logout
async function handleEmployeeLogout() {
  try {
    if (empState.token) {
      await fetch('/api/auth/employee/logout', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include'
      });
    }
  } catch (err) {
    console.warn('Logout network error:', err);
  } finally {
    if (empState.examTimerInterval) clearInterval(empState.examTimerInterval);
    localStorage.removeItem(STORAGE_KEY_EMP_SESSION);
    empState = {
      employee: null,
      token: null,
      exam: null,
      examQuestions: [],
      currentQIndex: 0,
      userAnswers: {},
      examTimerInterval: null,
      timeRemainingSec: (empSettings.examDurationMinutes || 45) * 60,
      tabSwitches: 0,
      isSubmitting: false
    };
    updateEmployeeNav();
    showToast('Signed out successfully.');
    showEmployeeView('viewEmpLogin');
  }
}
window.handleEmployeeLogout = handleEmployeeLogout;

// Load Employee Dashboard & Records
async function loadEmployeeDashboard() {
  const emp = empState.employee;
  if (!emp) return;

  await loadEmpPublicSettings();

  try {
    const meRes = await fetch('/api/auth/employee/me', {
      headers: getAuthHeaders(),
      credentials: 'include'
    });
    const meData = await meRes.json();
    if (meData.authenticated && meData.employee) {
      empState.employee = meData.employee;
      Object.assign(emp, meData.employee);
    }
  } catch (e) {}

  setText('dashEmpName', emp.name || 'Candidate');
  setText('dashEmpNo', emp.empNo || '-');
  setText('dashEmpDoj', emp.doj || '-');
  setText('dashEmpDueDate', emp.reAssessmentDate || '30-Jun-2026');
  setText('dashEmpDesignation', emp.designation || 'QA Inspector');
  setText('dashEmpDeptSec', `${emp.dept || 'Quality Control'} • ${emp.section || 'Tire Building QA'}`);

  const currentLevel = String(emp.currentLevel || emp.level || 'I').toUpperCase();
  const targetLevel = String(emp.targetLevel || currentLevel).toUpperCase();
  const qCount = (window.ILUO_CONSTANTS && window.ILUO_CONSTANTS.ILUO_LEVELS[targetLevel])
    ? window.ILUO_CONSTANTS.ILUO_LEVELS[targetLevel].questions
    : (targetLevel === 'O' ? 40 : targetLevel === 'U' ? 30 : 20);

  setText('dashExamDuration', `${empSettings.examDurationMinutes || 45} Minutes`);
  setText('dashExamQuestionCount', `${qCount} Questions`);
  setText('dashExamPassThresholds', `Exam ${getExamPassPct()}% / OJT ${getOjtPassPct()}%`);

  const lvlBadge = document.getElementById('dashLevelBadge');
  if (lvlBadge) {
    lvlBadge.innerText = currentLevel;
    lvlBadge.className = `iluo-badge iluo-badge-${currentLevel.toLowerCase()}`;
  }
  setText('dashLevelText', `Level ${currentLevel}: ${getLevelTitle(currentLevel)}`);

  const targetEl = document.getElementById('dashTargetLevel');
  if (targetEl) {
    if (emp.skillLevelExpBased && emp.skillLevelExpBased !== 'Not Eligible') {
      targetEl.innerHTML = `Level ${escapeEmpHtml(targetLevel)} <span style="font-size: 0.75rem; color: #0284C7; font-weight: 600;">(Experience Based)</span>`;
    } else {
      targetEl.innerText = `Level ${targetLevel}`;
    }
  }

  renderDojEligibilityAlert(emp, currentLevel);

  try {
    const res = await fetch('/api/records', {
      headers: getAuthHeaders(),
      credentials: 'include'
    });
    const data = await res.json();
    const records = data.records || {};
    const myRecord = records[emp.empNo];

    renderAssessmentCardStatus(myRecord, currentLevel, targetLevel);
    renderEmployeeProgressAndRoadmap(myRecord, currentLevel, targetLevel);
    renderAttemptHistoryTable(myRecord);
  } catch (err) {
    console.error('Error fetching candidate records:', err);
    renderEmployeeProgressAndRoadmap(null, currentLevel, targetLevel);
    renderAttemptHistoryTable(null, true);
  }
}

function renderDojEligibilityAlert(emp, currentLevel) {
  const banner = document.getElementById('dashEligibilityBanner');
  if (!banner || !window.ILUO_CONSTANTS || typeof window.ILUO_CONSTANTS.calculateDojEligibility !== 'function') return;
  const elig = window.ILUO_CONSTANTS.calculateDojEligibility(emp.doj, currentLevel);
  if (elig && elig.isDueForUpgrade) {
    banner.style.display = 'block';
    setText('dashEligibilityTitle', `DOJ Eligibility Notice: Ready for Level ${elig.eligibleLevel}`);
    setText('dashEligibilityText', `With ${elig.days} days of plant service (DOJ: ${emp.doj}), you are eligible to qualify for Level ${elig.eligibleLevel} (${getLevelTitle(elig.eligibleLevel)}).`);
  } else {
    banner.style.display = 'none';
  }
}

function getLevelTitle(lvl) {
  const levels = window.ILUO_CONSTANTS && window.ILUO_CONSTANTS.ILUO_LEVELS;
  if (levels && levels[lvl]) return levels[lvl].title;
  switch (lvl) {
    case 'I': return 'Beginner';
    case 'L': return 'Learner';
    case 'U': return 'Executor';
    case 'O': return 'Expert';
    default: return 'Executor';
  }
}

function renderEmployeeProgressAndRoadmap(record, currentLevel, targetLevel) {
  const order = { I: 1, L: 2, U: 3, O: 4 };
  const effectiveLevel = (record && record.isCompleted && record.isPassed !== false && record.switchedLevel)
    ? String(record.switchedLevel).toUpperCase()
    : currentLevel;

  const curRank = order[effectiveLevel] || 1;
  const tgtRank = order[targetLevel] || curRank;

  // Progress Ring Percentage: base level progress + latest score if completed
  let ringPct = curRank * 25;
  if (record && record.isCompleted) {
    const scorePct = Number(record.markPct ?? record.percentage ?? 0);
    ringPct = Math.max(curRank * 25, Math.min(100, scorePct));
  }
  const circle = document.getElementById('empProgressRingCircle');
  const circumference = 2 * Math.PI * 54;
  if (circle) {
    const offset = circumference - (Math.max(0, Math.min(100, ringPct)) / 100) * circumference;
    circle.style.strokeDasharray = String(circumference.toFixed(2));
    circle.style.strokeDashoffset = String(offset.toFixed(2));
    const colorMap = { I: '#64748B', L: '#F59E0B', U: '#005B9E', O: '#10B981' };
    circle.style.stroke = colorMap[effectiveLevel] || '#005B9E';
  }
  setText('empProgressRingPct', `${Math.round(ringPct)}%`);
  setText('empProgressRingSub', `Active Level ${effectiveLevel} (${getLevelTitle(effectiveLevel)})`);

  ['I', 'L', 'U', 'O'].forEach((lvl) => {
    const stepEl = document.getElementById(`step${lvl}`);
    const actualEl = document.getElementById(`actual${lvl}`);
    const rank = order[lvl];
    if (!stepEl || !actualEl) return;

    stepEl.classList.remove('done', 'target');
    if (rank <= curRank) {
      stepEl.classList.add('done');
      actualEl.innerText = 'Achieved ✓';
      actualEl.style.color = '#047857';
    } else if (rank === tgtRank || rank === curRank + 1) {
      stepEl.classList.add('target');
      actualEl.innerText = 'Current Target';
      actualEl.style.color = '#1D4ED8';
    } else {
      actualEl.innerText = 'Upcoming';
      actualEl.style.color = 'var(--text-muted)';
    }
  });
}

function renderAttemptHistoryTable(record, hasError = false) {
  const tbody = document.getElementById('empAttemptHistoryBody');
  if (!tbody) return;

  if (hasError) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#DC2626; padding:18px;">Unable to load attempt history. Check connection.</td></tr>';
    return;
  }

  let history = [];
  if (record && Array.isArray(record.attemptHistory) && record.attemptHistory.length > 0) {
    history = record.attemptHistory.slice().reverse();
  } else if (record && record.isCompleted) {
    history = [{
      date: record.attemptDate || '-',
      targetLevel: record.targetLevel || 'L',
      score: record.totalMark ?? record.score ?? 0,
      totalQuestions: record.totalQuestions || 30,
      markPct: record.markPct ?? record.percentage ?? 0,
      status: record.status || (record.isPassed ? 'Pass' : 'Fail')
    }];
  }

  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:18px;">No assessment attempts recorded yet. Click Start Assessment above to begin.</td></tr>';
    return;
  }

  tbody.innerHTML = history.map((h) => {
    const pct = Number(h.markPct ?? 0);
    const passed = pct >= getExamPassPct() || String(h.status || '').toLowerCase().includes('pass');
    const badgeBg = passed ? '#DCFCE7' : '#FEE2E2';
    const badgeCol = passed ? '#166534' : '#991B1B';
    return `
      <tr>
        <td data-label="Date">${escapeEmpHtml(h.date || '-')}</td>
        <td data-label="Target Level"><strong>Level ${escapeEmpHtml(h.targetLevel || '-')}</strong></td>
        <td data-label="Score">${escapeEmpHtml(String(h.score ?? 0))} / ${escapeEmpHtml(String(h.totalQuestions ?? 30))}</td>
        <td data-label="Percentage"><strong>${escapeEmpHtml(String(pct))}%</strong></td>
        <td data-label="Status"><span style="padding:3px 10px;border-radius:12px;font-size:0.78rem;font-weight:700;background:${badgeBg};color:${badgeCol};">${escapeEmpHtml(h.status || (passed ? 'Pass' : 'Fail'))}</span></td>
      </tr>
    `;
  }).join('');
}

function renderAssessmentCardStatus(record, currentLevel, targetLevel) {
  const badge = document.getElementById('dashExamStatusBadge');
  const btn = document.getElementById('btnStartExam');
  const resultCard = document.getElementById('dashResultContainer');
  const promoBanner = document.getElementById('dashPromotionBanner');
  const passPct = getExamPassPct();

  if (record && record.isCompleted) {
    const isPassed = record.isPassed !== false;
    if (badge) {
      badge.innerText = isPassed ? 'Completed & Passed' : 'Completed (Retake Required)';
      badge.style.background = isPassed ? '#DCFCE7' : '#FEE2E2';
      badge.style.color = isPassed ? '#15803D' : '#991B1B';
    }

    if (isPassed) {
      const finalLevel = (record.switchedLevel || record.targetLevel || targetLevel || currentLevel).toUpperCase();
      const lvlBadge = document.getElementById('dashLevelBadge');
      if (lvlBadge) {
        lvlBadge.innerText = finalLevel;
        lvlBadge.className = `iluo-badge iluo-badge-${finalLevel.toLowerCase()}`;
      }
      setText('dashLevelText', `Level ${finalLevel}: ${getLevelTitle(finalLevel)} (Qualified)`);
      if (promoBanner) {
        promoBanner.style.display = 'block';
        setText('dashPromoTitle', `Skill Level Qualified at Level ${finalLevel}!`);
        setText('dashPromoText', `Congratulations! Based on your experience and exam pass (>= ${passPct}%), your qualification is Level ${finalLevel} (${getLevelTitle(finalLevel)}).`);
      }
    } else if (promoBanner) {
      promoBanner.style.display = 'none';
    }

    if (btn) {
      btn.innerText = 'Retake Assessment';
      btn.className = 'btn-secondary';
    }
    if (resultCard) {
      resultCard.style.display = 'block';
      const statusBadge = document.getElementById('dashResultStatusBadge');
      if (statusBadge) {
        statusBadge.innerText = isPassed ? `PASSED (>= ${passPct}%)` : `RETAKE REQUIRED (< ${passPct}%)`;
        statusBadge.style.background = isPassed ? '#DCFCE7' : '#FEE2E2';
        statusBadge.style.color = isPassed ? '#166534' : '#991B1B';
      }

      const catMarks = record.categoryMarks || {};
      setText('scoreSafety', formatCatScore(catMarks.safety, 5));
      setText('scoreQuality', formatCatScore(catMarks.quality, 10));
      setText('scoreProcess', formatCatScore(catMarks.process, 10));
      setText('scoreCiTpm', formatCatScore(catMarks.ciTpm, 5));
    }
  } else {
    if (promoBanner) promoBanner.style.display = 'none';
    if (badge) {
      badge.innerText = 'Pending';
      badge.style.background = '#EFF6FF';
      badge.style.color = '#1D4ED8';
    }
    if (btn) {
      btn.innerText = 'Start Assessment »';
      btn.className = 'btn-primary';
    }
    if (resultCard) resultCard.style.display = 'none';
  }
}

function formatCatScore(val, max) {
  if (val === undefined || val === null) return `0 / ${max}`;
  return `${val} / ${max}`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

// Start Assessment
async function startEmployeeExam() {
  const emp = empState.employee;
  if (!emp || empState.isStartingExam) return;

  const targetLvl = emp.targetLevel || emp.currentLevel || emp.level || 'U';
  const startBtn = document.getElementById('btnStartExam');
  const originalBtnText = startBtn ? startBtn.innerText : '';
  empState.isStartingExam = true;
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.innerText = 'Starting Assessment...';
  }

  const doStartFetch = async () => {
    if (!getCsrfToken()) {
      await initCsrfToken();
    }
    return fetch('/api/exam/start', {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({
        empNo: emp.empNo,
        targetLevel: targetLvl,
        forceRetake: true
      })
    });
  };

  try {
    let res;
    try {
      res = await doStartFetch();
      if (res.status === 403) {
        // Refresh CSRF token once if expired after server reload
        await initCsrfToken();
        res = await doStartFetch();
      }
    } catch (networkErr) {
      // Transient proxy/network hiccup: wait briefly, refresh CSRF token, and retry once
      await new Promise((r) => setTimeout(r, 600));
      await initCsrfToken();
      res = await doStartFetch();
    }

    const data = await res.json();
    if (res.ok && data.success && data.activeExam) {
      empState.exam = data.activeExam;
      empState.examQuestions = data.activeExam.questions || [];
      empState.currentQIndex = 0;
      empState.userAnswers = {};
      empState.tabSwitches = 0;
      const durMin = data.activeExam.durationMinutes || empSettings.examDurationMinutes || 45;
      empState.timeRemainingSec = Number(data.activeExam.durationSeconds || (durMin * 60));

      setText('tabSwitchCountDisplay', `0 / ${getMaxTabSwitches()}`);
      startExamTimer();
      renderActiveQuestion();
      showEmployeeView('viewQuiz');
    } else {
      showToast(data.message || 'Could not initialize examination.', 'error');
    }
  } catch (err) {
    console.error('Start exam error:', err);
    showToast('Unable to reach assessment server. Please click Start Assessment again.', 'error');
  } finally {
    empState.isStartingExam = false;
    if (startBtn) {
      startBtn.disabled = false;
      if (originalBtnText) startBtn.innerText = originalBtnText;
    }
  }
}
window.startEmployeeExam = startEmployeeExam;

function startExamTimer() {
  if (empState.examTimerInterval) clearInterval(empState.examTimerInterval);

  updateTimerDisplay();
  empState.examTimerInterval = setInterval(() => {
    empState.timeRemainingSec--;
    updateTimerDisplay();

    if (empState.timeRemainingSec <= 0) {
      clearInterval(empState.examTimerInterval);
      empState.examTimerInterval = null;
      showToast('Exam time expired! Submitting answers automatically...', 'error');
      submitEmployeeExam(true);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  const safeSecs = Math.max(0, empState.timeRemainingSec);
  const mins = Math.floor(safeSecs / 60);
  const secs = safeSecs % 60;
  el.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  el.style.color = mins < 5 ? '#DC2626' : '#E31B23';
}

function renderEmployeeQuizProgressSidebar() {
  const listEl = document.getElementById('empQuizProgressList');
  if (!listEl) return;
  const questions = empState.examQuestions || [];
  const currentIdx = empState.currentQIndex || 0;

  listEl.innerHTML = questions.map((item, idx) => {
    const isAnswered = empState.userAnswers && empState.userAnswers[item.id] !== undefined;
    const isCurrent = idx === currentIdx;
    let stateClass = 'is-upcoming';
    let stateLabel = 'Upcoming';
    if (isCurrent) {
      stateClass = 'is-current';
      stateLabel = isAnswered ? 'Selected' : 'Current';
    } else if (idx < currentIdx || isAnswered) {
      stateClass = 'is-done';
      stateLabel = 'Done';
    }
    const num = String(idx + 1).padStart(2, '0');
    const cat = escapeEmpHtml(item.category || 'General');
    return `
      <div class="emp-q-progress-row ${stateClass}" data-q-index="${idx}" aria-current="${isCurrent ? 'step' : 'false'}">
        <span class="emp-q-num">${num}</span>
        <span class="emp-q-cat">${cat}</span>
        <span class="emp-q-state">${stateLabel}</span>
      </div>
    `;
  }).join('');

  const activeRow = listEl.querySelector('.emp-q-progress-row.is-current');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderActiveQuestion() {
  const questions = empState.examQuestions;
  const index = empState.currentQIndex;
  if (!questions || index >= questions.length) return;

  const q = questions[index];
  setText('quizProgressText', `Question ${index + 1} of ${questions.length}`);
  setText('qNumberBadge', `Q${index + 1}`);
  setText('quizSubText', `Level ${empState.exam.targetLevel || 'U'} Skill Assessment • Pass >= ${getExamPassPct()}%`);
  setText('qCategoryTag', q.category || 'General');
  setText('qTitleText', q.text || q.question || 'Question content');

  const updateQuizProgressUi = () => {
    const answeredCount = Object.keys(empState.userAnswers || {}).length;
    const totalCount = questions.length || 1;
    const pct = Math.round((answeredCount / totalCount) * 100);
    setText('quizAnsweredCount', `Answered: ${answeredCount} / ${totalCount}`);
    setText('quizProgressPct', `${pct}%`);
    const fill = document.getElementById('quizProgressBarFill');
    if (fill) fill.style.width = `${pct}%`;
    renderEmployeeQuizProgressSidebar();
  };
  updateQuizProgressUi();

  const container = document.getElementById('optionsContainer');
  if (!container) return;
  container.innerHTML = '';

  const chosenAns = empState.userAnswers[q.id];
  const btnNext = document.getElementById('btnNextQ');
  if (btnNext) {
    btnNext.disabled = (chosenAns === undefined);
    btnNext.innerText = (index === questions.length - 1) ? 'Finish & Sign Assessment »' : 'Next Question »';
  }

  const options = q.options || [];
  const defaultKeys = ['A', 'B', 'C', 'D', 'E', 'F'];
  options.forEach((opt, optIdx) => {
    const optKey = (typeof opt === 'object' && opt && opt.key) ? opt.key : defaultKeys[optIdx] || String(optIdx);
    const optText = (typeof opt === 'object' && opt && opt.text) ? opt.text : String(opt);
    const isSelected = (chosenAns === optKey);
    const item = document.createElement('div');
    item.className = `option-item emp-quiz-option ${isSelected ? 'selected' : ''}`;
    item.setAttribute('role', 'radio');
    item.setAttribute('aria-checked', String(isSelected));
    item.tabIndex = 0;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `opt_${q.id}`;
    radio.value = optKey;
    radio.checked = isSelected;
    radio.style.accentColor = 'var(--primary-color)';
    radio.style.width = '18px';
    radio.style.height = '18px';
    radio.style.flexShrink = '0';

    const keyBadge = document.createElement('strong');
    keyBadge.style.minWidth = '24px';
    keyBadge.style.color = 'var(--primary-color)';
    keyBadge.style.fontVariantNumeric = 'tabular-nums';
    keyBadge.innerText = `${optKey}.`;

    const span = document.createElement('span');
    span.className = 'option-label-text';
    span.innerText = optText;

    const selectThisOption = () => {
      radio.checked = true;
      empState.userAnswers[q.id] = optKey;
      if (btnNext) btnNext.disabled = false;
      document.querySelectorAll('#optionsContainer .option-item').forEach((el) => {
        el.classList.remove('selected');
        el.setAttribute('aria-checked', 'false');
      });
      item.classList.add('selected');
      item.setAttribute('aria-checked', 'true');
      updateQuizProgressUi();
    };

    item.onclick = selectThisOption;
    item.onkeydown = (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        selectThisOption();
      }
    };

    item.appendChild(radio);
    item.appendChild(keyBadge);
    item.appendChild(span);
    container.appendChild(item);
  });
}

function handleNextQuestion() {
  const questions = empState.examQuestions;
  if (empState.currentQIndex < questions.length - 1) {
    empState.currentQIndex++;
    renderActiveQuestion();
  } else {
    openSignatureModal();
  }
}
window.handleNextQuestion = handleNextQuestion;

// Signature Canvas
let signatureState = {
  isDrawing: false,
  hasSigned: false,
  canvas: null,
  ctx: null,
  lastX: 0,
  lastY: 0,
  initialized: false
};

function initSignatureCanvas() {
  const canvas = document.getElementById('signatureCanvas');
  if (!canvas) return;
  signatureState.canvas = canvas;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width || 470;
  const height = 180;

  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  signatureState.ctx = ctx;
  signatureState.hasSigned = false;
  ctx.clearRect(0, 0, width, height);

  if (signatureState.initialized) return;
  signatureState.initialized = true;

  function getPos(e) {
    const cRect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return { x: clientX - cRect.left, y: clientY - cRect.top };
  }

  function start(e) {
    e.preventDefault();
    signatureState.isDrawing = true;
    const pos = getPos(e);
    signatureState.lastX = pos.x;
    signatureState.lastY = pos.y;
  }

  function move(e) {
    if (!signatureState.isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    const c = signatureState.ctx;
    c.beginPath();
    c.moveTo(signatureState.lastX, signatureState.lastY);
    c.lineTo(pos.x, pos.y);
    c.strokeStyle = '#002B49';
    c.lineWidth = 2.5;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();

    signatureState.lastX = pos.x;
    signatureState.lastY = pos.y;
    signatureState.hasSigned = true;
    const guide = document.getElementById('signatureGuideText');
    if (guide) guide.style.display = 'none';
  }

  function stop(e) {
    if (signatureState.isDrawing) {
      e.preventDefault();
      signatureState.isDrawing = false;
    }
  }

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', stop, { passive: false });
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', stop);
  canvas.addEventListener('mouseleave', stop);
}

function openSignatureModal() {
  const modal = document.getElementById('signatureModal');
  if (!modal) return;
  modal.style.display = 'flex';

  if (empState.employee) {
    setText('signModalEmpName', empState.employee.name || 'Candidate');
    setText('signModalEmpNo', empState.employee.empNo || '');
  }
  setText('signModalDate', new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }));
  const guide = document.getElementById('signatureGuideText');
  if (guide) guide.style.display = 'block';
  setTimeout(initSignatureCanvas, 50);
}
window.openSignatureModal = openSignatureModal;

function closeSignatureModal() {
  const modal = document.getElementById('signatureModal');
  if (modal) modal.style.display = 'none';
}
window.closeSignatureModal = closeSignatureModal;

function clearSignatureCanvas() {
  if (!signatureState.canvas || !signatureState.ctx) return;
  const rect = signatureState.canvas.getBoundingClientRect();
  signatureState.ctx.clearRect(0, 0, rect.width || 470, 180);
  signatureState.hasSigned = false;
  const guide = document.getElementById('signatureGuideText');
  if (guide) guide.style.display = 'block';
}
window.clearSignatureCanvas = clearSignatureCanvas;

function confirmSignatureAndSubmit() {
  if (!signatureState.hasSigned) {
    showToast('Please provide your signature before finishing.', 'error');
    return;
  }
  const signatureDataUrl = signatureState.canvas ? signatureState.canvas.toDataURL('image/png') : '';
  closeSignatureModal();
  submitEmployeeExam(false, signatureDataUrl);
}
window.confirmSignatureAndSubmit = confirmSignatureAndSubmit;

// Offline Exam Queue Helpers
function getOfflineExamQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_OFFLINE_QUEUE);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveOfflineExamQueue(arr) {
  try {
    if (!arr || arr.length === 0) {
      localStorage.removeItem(STORAGE_KEY_OFFLINE_QUEUE);
    } else {
      localStorage.setItem(STORAGE_KEY_OFFLINE_QUEUE, JSON.stringify(arr));
    }
  } catch (e) {}
  updateOfflineQueueBanner();
}

function updateOfflineQueueBanner() {
  const banner = document.getElementById('offlineQueueBanner');
  const textEl = document.getElementById('offlineQueueText');
  const queue = getOfflineExamQueue();
  if (!banner) return;
  if (queue.length > 0) {
    banner.style.display = 'flex';
    if (textEl) textEl.innerText = `${queue.length} offline exam submission(s) saved locally and awaiting network sync.`;
  } else {
    banner.style.display = 'none';
  }
}

function queueOfflineExamPayload(payload) {
  const q = getOfflineExamQueue();
  const filtered = q.filter((item) => item.empNo !== payload.empNo);
  filtered.push({ ...payload, queuedAt: new Date().toISOString() });
  saveOfflineExamQueue(filtered);
}

async function flushOfflineExamQueue() {
  const queue = getOfflineExamQueue();
  updateOfflineQueueBanner();
  if (queue.length === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false) || !empState.token) {
    return;
  }

  const remaining = [];
  let syncedCount = 0;
  for (const item of queue) {
    try {
      const res = await fetch('/api/exam/submit', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          empNo: item.empNo,
          answers: item.answers,
          candidateSignature: item.candidateSignature || '',
          tabSwitchCount: item.tabSwitchCount || 0
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        syncedCount++;
      } else if (res.status === 409) {
        // Already submitted on server; drop duplicate queue entry
      } else {
        remaining.push(item);
      }
    } catch (e) {
      remaining.push(item);
    }
  }
  saveOfflineExamQueue(remaining);
  if (syncedCount > 0) {
    showToast(`Synced ${syncedCount} offline exam submission(s) to server!`, 'success');
    await loadEmployeeDashboard();
  }
}
window.flushOfflineExamQueue = flushOfflineExamQueue;

function setupOfflineSyncListeners() {
  updateOfflineQueueBanner();
  window.addEventListener('online', () => {
    flushOfflineExamQueue();
  });
}

// Submit Exam (offline tolerant)
async function submitEmployeeExam(isAuto = false, candidateSignature = '') {
  if (empState.isSubmitting) return;
  empState.isSubmitting = true;

  if (empState.examTimerInterval) {
    clearInterval(empState.examTimerInterval);
    empState.examTimerInterval = null;
  }

  const payload = {
    empNo: empState.employee.empNo,
    answers: empState.userAnswers,
    candidateSignature: candidateSignature || '',
    tabSwitchCount: empState.tabSwitches || 0
  };

  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queueOfflineExamPayload(payload);
      showToast('Offline detected: your exam responses were safely saved and will auto-sync when online.', 'info');
      showEmployeeView('viewEmpDashboard');
      return;
    }

    const res = await fetch('/api/exam/submit', {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success && data.record) {
      if (candidateSignature && !data.record.candidateSignature) {
        data.record.candidateSignature = candidateSignature;
      }
      if (data.record.isPassed && empState.employee) {
        const newLevel = data.record.switchedLevel || data.record.targetLevel;
        if (newLevel) empState.employee.currentLevel = newLevel;
      }
      showResultView(data.record);
    } else {
      showToast(data.message || 'Submission error', 'error');
      await loadEmployeeDashboard();
      showEmployeeView('viewEmpDashboard');
    }
  } catch (err) {
    console.error('Submit exam error:', err);
    queueOfflineExamPayload(payload);
    showToast('Network unreachable: exam submission queued locally for auto-sync.', 'error');
    showEmployeeView('viewEmpDashboard');
  } finally {
    empState.isSubmitting = false;
  }
}

function showResultView(record) {
  const total = record.totalQuestions || 30;
  const score = record.totalMark ?? record.score ?? 0;
  const percentage = record.markPct ?? record.percentage ?? Math.round((score / total) * 100);
  const isPassed = record.isPassed !== false;
  const passPct = getExamPassPct();

  setText('resultScoreLarge', `${score} / ${total} (${percentage}%)`);

  const passBadge = document.getElementById('resultPassBadge');
  if (passBadge) {
    passBadge.innerText = isPassed ? `PASSED (Threshold: ${passPct}%)` : `RETAKE REQUIRED (< ${passPct}%)`;
    passBadge.style.background = isPassed ? '#DCFCE7' : '#FEE2E2';
    passBadge.style.color = isPassed ? '#166534' : '#991B1B';
  }

  const switchNotice = document.getElementById('resultSwitchNotice');
  if (switchNotice) {
    if (isPassed) {
      const switchedTo = record.switchedLevel || record.targetLevel || 'O';
      switchNotice.style.display = 'block';
      switchNotice.innerHTML = `<strong>Skill Level Qualified!</strong> Achieved <strong>Level ${escapeEmpHtml(switchedTo)}</strong> (${escapeEmpHtml(getLevelTitle(switchedTo))}) based on experience &amp; exam completion.`;
    } else {
      switchNotice.style.display = 'none';
    }
  }

  const catMarks = record.categoryMarks || {};
  setText('resSafety', formatCatScore(catMarks.safety, 5));
  setText('resQuality', formatCatScore(catMarks.quality, 10));
  setText('resProcess', formatCatScore(catMarks.process, 10));
  setText('resCiTpm', formatCatScore(catMarks.ciTpm, 5));

  const sigBox = document.getElementById('resultSignatureBox');
  const sigImg = document.getElementById('resultSignatureImg');
  if (sigBox && sigImg && record.candidateSignature) {
    sigImg.src = record.candidateSignature;
    sigBox.style.display = 'block';
  } else if (sigBox) {
    sigBox.style.display = 'none';
  }

  showEmployeeView('viewResult');
}

async function handleReturnToDashboard() {
  await loadEmployeeDashboard();
  showEmployeeView('viewEmpDashboard');
}
window.handleReturnToDashboard = handleReturnToDashboard;

// QR Certificate Viewer Modal
async function openEmployeeCertificate() {
  if (!empState.employee || !empState.employee.empNo) return;
  const modal = document.getElementById('empCertificateModal');
  const content = document.getElementById('empCertContent');
  if (!modal || !content) return;

  content.innerHTML = '<div style="text-align:center; padding: 24px; color: var(--text-muted);">Generating verifiable QR Certificate...</div>';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/certificate/${encodeURIComponent(empState.employee.empNo)}`, {
      headers: getAuthHeaders(),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.certificate) {
      content.innerHTML = `<div style="text-align:center; padding: 20px; color:#DC2626;">${escapeEmpHtml(data.message || 'Unable to load certificate.')}</div>`;
      return;
    }
    const c = data.certificate;
    content.innerHTML = `
      <div class="certificate-card">
        <div style="font-size:0.78rem; font-weight:800; color:#005B9E; letter-spacing:1.4px;">YOKOHAMA ATC TIRES &bull; ILUO QUALIFICATION</div>
        <h2 style="margin:6px 0 4px; color:#003D6B; font-size:1.35rem;">Skill Competency Certificate</h2>
        <div style="font-size:0.78rem; color:#64748B; margin-bottom:14px;">Certificate No: <strong>${escapeEmpHtml(c.certificateNo)}</strong></div>
        <div style="font-size:1.25rem; font-weight:800; color:#0F172A;">${escapeEmpHtml(c.name)}</div>
        <div style="font-size:0.86rem; color:#334155; margin-top:4px;">ID: <strong>${escapeEmpHtml(c.empNo)}</strong> &bull; ${escapeEmpHtml(c.dept)} &bull; ${escapeEmpHtml(c.section)}</div>
        <div style="margin:14px auto; display:inline-block; padding:8px 18px; border-radius:8px; background:#EFF6FF; color:#005B9E; font-weight:800; font-size:1rem;">
          Qualified Level ${escapeEmpHtml(c.qualifiedLevel)} &mdash; ${escapeEmpHtml(c.levelTitle)}
        </div>
        <div style="display:flex; justify-content:center; gap:20px; font-size:0.84rem; color:#475569; margin-bottom:14px; flex-wrap:wrap;">
          <span>MCQ Exam: <strong>${c.examPct !== null && c.examPct !== undefined ? escapeEmpHtml(String(c.examPct)) + '%' : 'Pending'}</strong></span>
          <span>OJT Practical: <strong>${c.ojtPct !== null && c.ojtPct !== undefined ? escapeEmpHtml(String(c.ojtPct)) + '%' : 'Pending'}</strong></span>
          <span>Date: <strong>${escapeEmpHtml(c.attemptDate || '-')}</strong></span>
        </div>
        <div>
          <img src="${escapeEmpHtml(c.qrDataUrl)}" alt="Certificate Verification QR Code" style="width:130px;height:130px;border:1px solid #E2E8F0;border-radius:8px;padding:4px;background:#fff;">
        </div>
        <div style="font-size:0.72rem; color:#64748B; margin-top:6px;">Scan QR to verify authenticity online</div>
      </div>
    `;
  } catch (err) {
    content.innerHTML = '<div style="text-align:center; padding: 20px; color:#DC2626;">Network error loading certificate.</div>';
  }
}
window.openEmployeeCertificate = openEmployeeCertificate;

function closeEmployeeCertificateModal() {
  const modal = document.getElementById('empCertificateModal');
  if (modal) modal.style.display = 'none';
}
window.closeEmployeeCertificateModal = closeEmployeeCertificateModal;

// Server-Synced Anti-Cheating Tab Switch Monitor
function setupTabSwitchDetection() {
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden && empState.examTimerInterval && empState.employee) {
      empState.tabSwitches++;
      let maxAllowed = getMaxTabSwitches();
      let action = empSettings.tabSwitchAction || 'terminate';
      let limitReached = empState.tabSwitches >= maxAllowed;

      try {
        const res = await fetch('/api/exam/tab-switch', {
          method: 'POST',
          headers: getAuthHeaders(),
          credentials: 'include',
          body: JSON.stringify({ empNo: empState.employee.empNo })
        });
        const data = await res.json();
        if (data && data.success) {
          empState.tabSwitches = Number(data.tabSwitchCount || empState.tabSwitches);
          maxAllowed = Number(data.maxTabSwitches || maxAllowed);
          action = data.action || action;
          limitReached = Boolean(data.limitReached);
        }
      } catch (e) {}

      setText('tabSwitchCountDisplay', `${empState.tabSwitches} / ${maxAllowed}`);
      if (limitReached && action === 'terminate') {
        showToast('Maximum tab switches exceeded. Auto-submitting assessment...', 'error');
        submitEmployeeExam(true);
      } else if (limitReached) {
        showToast(`Warning: Tab switch limit (${empState.tabSwitches}/${maxAllowed}) reached and logged.`, 'error');
      } else {
        showToast(`Warning: Tab switch detected (${empState.tabSwitches}/${maxAllowed}). Stay on assessment screen.`, 'error');
      }
    }
  });
}
