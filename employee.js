/**
 * Yokohama ILUO - Dedicated Employee Portal Controller
 * Authoritative single-source API client for employee assessments and skill tracking
 */

const STORAGE_KEY_EMP_SESSION = 'yokohama_emp_session';

// State container
let empState = {
  employee: null,
  token: null,
  exam: null,
  examQuestions: [],
  currentQIndex: 0,
  userAnswers: {},
  examTimerInterval: null,
  timeRemainingSec: 2700, // 45 mins
  tabSwitches: 0,
  isSubmitting: false
};

// DOM ready initialization
document.addEventListener('DOMContentLoaded', () => {
  setupTabSwitchDetection();
  checkExistingSession();
});

// Navigation helper between views
function showEmployeeView(viewId) {
  const views = ['viewEmpLogin', 'viewEmpDashboard', 'viewQuiz', 'viewResult'];
  views.forEach(id => {
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
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
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
  toast.style.animation = 'fadeIn 0.25s ease';
  toast.style.pointerEvents = 'auto';

  if (type === 'error') {
    toast.style.background = '#DC2626';
  } else if (type === 'success') {
    toast.style.background = '#15803D';
  } else {
    toast.style.background = '#0F172A';
  }

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
    showEmployeeView('viewEmpLogin');
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !parsed.token || !parsed.empNo) {
      showEmployeeView('viewEmpLogin');
      return;
    }

    const res = await fetch('/api/auth/employee/me', {
      headers: {
        'x-emp-token': parsed.token
      }
    });

    const data = await res.json();
    if (data.authenticated && data.employee) {
      empState.employee = data.employee;
      empState.token = parsed.token;
      updateEmployeeNav();
      await loadEmployeeDashboard();
      showEmployeeView('viewEmpDashboard');
    } else {
      localStorage.removeItem(STORAGE_KEY_EMP_SESSION);
      showEmployeeView('viewEmpLogin');
    }
  } catch (err) {
    console.error('Session verify error:', err);
    showEmployeeView('viewEmpLogin');
  }
}

// Update top nav user badge
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
    if (btnSignOut) btnSignOut.style.display = 'none';
  }
}

// Handle Employee Login
async function handleEmployeeLogin(e) {
  if (e) e.preventDefault();
  const empIdInput = document.getElementById('empIdInput');
  const empPasswordInput = document.getElementById('empPasswordInput');

  const empNo = empIdInput ? empIdInput.value.trim() : '';
  const password = empPasswordInput ? empPasswordInput.value.trim() : '';

  if (!empNo || !password) {
    showToast('Please enter both Employee ID and password.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/employee/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ empNo, password })
    });

    const data = await res.json();

    if (data.success && data.token) {
      empState.employee = data.employee;
      empState.token = data.token;

      localStorage.setItem(STORAGE_KEY_EMP_SESSION, JSON.stringify({
        token: data.token,
        empNo: data.employee.empNo,
        name: data.employee.name
      }));

      updateEmployeeNav();
      showToast(`Welcome, ${data.employee.name}!`, 'success');
      await loadEmployeeDashboard();
      showEmployeeView('viewEmpDashboard');
    } else {
      showToast(data.message || 'Invalid Employee ID or password.', 'error');
    }
  } catch (err) {
    console.error('Login error:', err);
    showToast('Unable to connect to authentication server.', 'error');
  }
}
window.handleEmployeeLogin = handleEmployeeLogin;

// Handle Employee Logout
async function handleEmployeeLogout() {
  try {
    if (empState.token) {
      await fetch('/api/auth/employee/logout', {
        method: 'POST',
        headers: { 'x-emp-token': empState.token },
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
      timeRemainingSec: 2700,
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

  // Populate Profile
  setText('dashEmpName', emp.name || 'Candidate');
  setText('dashEmpNo', emp.empNo || '-');
  setText('dashEmpDoj', emp.doj || '01-Jan-2024');
  setText('dashEmpDueDate', emp.reAssessmentDate || '30-Jun-2026');
  setText('dashEmpDesignation', emp.designation || 'QA Inspector');
  setText('dashEmpDeptSec', `${emp.dept || 'Quality Control'} • ${emp.section || 'Tire Building'}`);

  const level = (emp.level || 'U').toUpperCase();
  const lvlBadge = document.getElementById('dashLevelBadge');
  if (lvlBadge) {
    lvlBadge.innerText = level;
    lvlBadge.className = `iluo-badge iluo-badge-${level.toLowerCase()}`;
  }
  setText('dashLevelText', `Level ${level}: ${getLevelTitle(level)}`);
  setText('dashTargetLevel', `Level ${level}`);

  // Fetch candidate record authoritatively
  try {
    const res = await fetch('/api/records', {
      headers: { 'x-emp-token': empState.token }
    });
    const data = await res.json();
    const records = data.records || {};
    const myRecord = records[emp.empNo];

    renderAssessmentCardStatus(myRecord, level);
  } catch (err) {
    console.error('Error fetching candidate records:', err);
  }
}

function getLevelTitle(lvl) {
  switch (lvl) {
    case 'I': return 'Beginner';
    case 'L': return 'Learner';
    case 'U': return 'Executor';
    case 'O': return 'Expert';
    default: return 'Executor';
  }
}

function renderAssessmentCardStatus(record, currentLevel) {
  const badge = document.getElementById('dashExamStatusBadge');
  const btn = document.getElementById('btnStartExam');
  const resultCard = document.getElementById('dashResultContainer');

  if (record && record.isCompleted) {
    if (badge) {
      badge.innerText = 'Completed';
      badge.style.background = '#DCFCE7';
      badge.style.color = '#15803D';
    }
    if (btn) {
      btn.innerText = 'Retake Assessment';
      btn.className = 'btn-secondary';
      btn.style.background = '#F1F5F9';
      btn.style.color = '#334155';
      btn.style.border = '1px solid #CBD5E1';
    }
    if (resultCard) {
      resultCard.style.display = 'block';
      const isPassed = record.isPassed !== false;
      const statusBadge = document.getElementById('dashResultStatusBadge');
      if (statusBadge) {
        statusBadge.innerText = isPassed ? 'PASSED' : 'RETAKE REQUIRED';
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
    if (badge) {
      badge.innerText = 'Pending';
      badge.style.background = '#EFF6FF';
      badge.style.color = '#1D4ED8';
    }
    if (btn) {
      btn.innerText = 'Start Assessment »';
      btn.className = 'btn-primary';
      btn.style.background = 'linear-gradient(135deg, #003D6B 0%, #005B9E 100%)';
      btn.style.color = '#FFFFFF';
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
  if (!emp) return;

  try {
    const res = await fetch('/api/exam/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-emp-token': empState.token
      },
      body: JSON.stringify({
        empNo: emp.empNo,
        targetLevel: emp.level || 'U',
        forceRetake: true
      })
    });

    const data = await res.json();
    if (data.success && data.activeExam) {
      empState.exam = data.activeExam;
      empState.examQuestions = data.activeExam.questions || [];
      empState.currentQIndex = 0;
      empState.userAnswers = {};
      empState.tabSwitches = 0;
      empState.timeRemainingSec = (data.activeExam.durationMinutes || 45) * 60;

      setText('tabSwitchCountDisplay', '0 / 3');
      startExamTimer();
      renderActiveQuestion();
      showEmployeeView('viewQuiz');
    } else {
      showToast(data.message || 'Could not initialize examination.', 'error');
    }
  } catch (err) {
    console.error('Start exam error:', err);
    showToast('Failed to start exam. Please check server connection.', 'error');
  }
}
window.startEmployeeExam = startEmployeeExam;

// Start Countdown Timer
function startExamTimer() {
  if (empState.examTimerInterval) clearInterval(empState.examTimerInterval);

  updateTimerDisplay();
  empState.examTimerInterval = setInterval(() => {
    empState.timeRemainingSec--;
    updateTimerDisplay();

    if (empState.timeRemainingSec <= 0) {
      clearInterval(empState.examTimerInterval);
      showToast('Exam time expired! Submitting answers automatically...', 'error');
      submitEmployeeExam(true);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  const mins = Math.floor(empState.timeRemainingSec / 60);
  const secs = empState.timeRemainingSec % 60;
  el.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  if (mins < 5) {
    el.style.color = '#DC2626';
  }
}

// Render active question
function renderActiveQuestion() {
  const questions = empState.examQuestions;
  const index = empState.currentQIndex;
  if (!questions || index >= questions.length) return;

  const q = questions[index];
  setText('quizProgressText', `Question ${index + 1} of ${questions.length}`);
  setText('qNumberBadge', `Q${index + 1}`);
  setText('quizSubText', `Level ${empState.exam.targetLevel || 'U'} Skill Assessment`);
  setText('qCategoryTag', q.category || 'General');
  setText('qTitleText', q.text || q.question || 'Question content');

  const container = document.getElementById('optionsContainer');
  if (!container) return;
  container.innerHTML = '';

  const chosenAns = empState.userAnswers[q.id];
  const btnNext = document.getElementById('btnNextQ');
  if (btnNext) {
    btnNext.disabled = (chosenAns === undefined);
    btnNext.innerText = (index === questions.length - 1) ? 'Submit Assessment ✓' : 'Next Question »';
  }

  const options = q.options || [];
  options.forEach((opt, optIdx) => {
    const isSelected = (chosenAns === optIdx);
    const item = document.createElement('label');
    item.className = `option-item ${isSelected ? 'selected' : ''}`;
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '12px';
    item.style.padding = '14px 18px';
    item.style.background = isSelected ? '#EFF6FF' : '#F8FAFC';
    item.style.border = isSelected ? '2px solid #005B9E' : '1px solid #E2E8F0';
    item.style.borderRadius = '10px';
    item.style.cursor = 'pointer';
    item.style.transition = 'all 0.15s ease';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `opt_${q.id}`;
    radio.value = optIdx;
    radio.checked = isSelected;
    radio.style.accentColor = '#005B9E';
    radio.style.width = '18px';
    radio.style.height = '18px';

    radio.onchange = () => {
      empState.userAnswers[q.id] = optIdx;
      if (btnNext) btnNext.disabled = false;
      renderActiveQuestion();
    };

    const span = document.createElement('span');
    span.style.fontSize = '0.94rem';
    span.style.fontWeight = isSelected ? '700' : '500';
    span.style.color = isSelected ? '#003D6B' : '#0F172A';
    span.innerText = opt;

    item.appendChild(radio);
    item.appendChild(span);
    container.appendChild(item);
  });
}

// Next Question / Finish handler
function handleNextQuestion() {
  const questions = empState.examQuestions;
  if (empState.currentQIndex < questions.length - 1) {
    empState.currentQIndex++;
    renderActiveQuestion();
  } else {
    // Final question submission
    submitEmployeeExam();
  }
}
window.handleNextQuestion = handleNextQuestion;

// Submit Exam
async function submitEmployeeExam(isAuto = false) {
  if (empState.isSubmitting) return;
  empState.isSubmitting = true;

  if (empState.examTimerInterval) clearInterval(empState.examTimerInterval);

  try {
    const res = await fetch('/api/exam/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-emp-token': empState.token
      },
      body: JSON.stringify({
        empNo: empState.employee.empNo,
        answers: empState.userAnswers
      })
    });

    const data = await res.json();
    if (data.success && data.record) {
      showResultView(data.record);
    } else {
      showToast(data.message || 'Submission error', 'error');
      await loadEmployeeDashboard();
      showEmployeeView('viewEmpDashboard');
    }
  } catch (err) {
    console.error('Submit exam error:', err);
    showToast('Failed to submit exam. Please contact supervisor.', 'error');
  } finally {
    empState.isSubmitting = false;
  }
}

// Render Results View
function showResultView(record) {
  const total = record.totalQuestions || 30;
  const score = record.score || 0;
  const percentage = record.percentage || Math.round((score / total) * 100);
  const isPassed = record.isPassed !== false;

  setText('resultScoreLarge', `${score} / ${total} (${percentage}%)`);

  const passBadge = document.getElementById('resultPassBadge');
  if (passBadge) {
    passBadge.innerText = isPassed ? 'PASSED (Threshold: 50%)' : 'RETAKE REQUIRED (< 50%)';
    passBadge.style.background = isPassed ? '#DCFCE7' : '#FEE2E2';
    passBadge.style.color = isPassed ? '#166534' : '#991B1B';
  }

  const catMarks = record.categoryMarks || {};
  setText('resSafety', formatCatScore(catMarks.safety, 5));
  setText('resQuality', formatCatScore(catMarks.quality, 10));
  setText('resProcess', formatCatScore(catMarks.process, 10));
  setText('resCiTpm', formatCatScore(catMarks.ciTpm, 5));

  showEmployeeView('viewResult');
}

// Anti-cheating tab switch monitor
function setupTabSwitchDetection() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && empState.examTimerInterval) {
      empState.tabSwitches++;
      setText('tabSwitchCountDisplay', `${empState.tabSwitches} / 3`);
      if (empState.tabSwitches >= 3) {
        showToast('Maximum tab switches exceeded. Exam logged.', 'error');
      } else {
        showToast(`Warning: Tab switch detected (${empState.tabSwitches}/3). Stay on assessment screen.`, 'error');
      }
    }
  });
}
