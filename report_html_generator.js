// =====================================================================
// YOKOHAMA OFFICIAL ASSESSMENT & OJT REPORT HTML GENERATOR
// Pixel-perfect A4 printable layout matching official Word (.docx) format
// =====================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateOfficialReportHtml(emp, examRecord, qbQuestions, ojtRec, ojtTmpl, logoBase64 = '') {
  emp = emp || {};
  examRecord = examRecord || {};
  qbQuestions = qbQuestions || [];
  ojtRec = ojtRec || {};
  ojtTmpl = ojtTmpl || {};

  const empNo = escapeHtml(emp.empNo || '900262');
  const name = escapeHtml(emp.name || 'Employee ' + empNo);
  const dept = escapeHtml(emp.dept || 'QUALITY CONTROL');
  const section = escapeHtml(emp.section || 'Tire building QA');
  const doj = escapeHtml(emp.doj || '-');
  const isAttempted = Boolean((examRecord && examRecord.isCompleted) || (examRecord && examRecord.inProgress) || (examRecord && examRecord.submittedQuestions && examRecord.submittedQuestions.length > 0));
  const date = isAttempted ? escapeHtml(examRecord.attemptDate || '-') : '-';

  const curLevel = escapeHtml(emp.currentLevel || 'I');
  const tgtLevel = escapeHtml(examRecord.targetLevel || emp.targetLevel || (curLevel === 'I' ? 'L' : curLevel === 'L' ? 'U' : 'O'));
  const totalMark = isAttempted ? ((examRecord.totalMark !== undefined) ? examRecord.totalMark : 0) : null;
  const markPct = isAttempted ? Math.round((totalMark / 30) * 100) : 0;
  const isPass = isAttempted && totalMark >= 21;
  const examStatus = isAttempted ? (isPass ? 'PASS (≥21)' : 'RETEST (<21)') : 'PENDING';
  const marksDisplay = isAttempted ? `${totalMark} / 30 Marks` : 'Pending Exam';

  // Build Questions HTML
  const userAnswers = examRecord.userAnswers || {};
  let questionsHtml = '';
  let currentCategory = '';

  const rawQuestions = (qbQuestions && qbQuestions.length > 0) ? qbQuestions : [
    { id: 1, category: 'Safety', text: 'What is safety? / பாதுகாப்பு என்றால் என்ன?', options: { A: 'To prevent injury and ill health', B: 'Getting injury', C: 'Performing unsafe act', D: 'Exposure to unsafe condition' }, answer: 'A' },
    { id: 2, category: 'Safety', text: 'What is PPE? / PPE என்றால் என்ன?', options: { A: 'Personal Performance Equipment', B: 'People Performance Equipment', C: 'Personal Process Equipment', D: 'Personal Protective Equipment' }, answer: 'D' },
    { id: 3, category: 'CI & TPM', text: 'Which step of the 5S methodology involves identifying and labeling items?', options: { A: 'Sort', B: 'Set in Order', C: 'Shine', D: 'Standardize' }, answer: 'B' }
  ];
  // Strictly enforce 30 questions matching official examination format
  const questionsToRender = rawQuestions.slice(0, 30);

  questionsToRender.forEach((q, idx) => {
    const qNum = idx + 1;
    const cat = q.category || 'QA & Process';
    if (cat !== currentCategory) {
      currentCategory = cat;
      questionsHtml += `
        <div class="category-header">
          <span>${escapeHtml(currentCategory)}</span>
        </div>
      `;
    }

    const qText = escapeHtml(q.text || q.question || `Question ${qNum}`);
    const corrAns = (q.answer || q.correctAnswer || 'A').toUpperCase().trim();
    const userAns = (userAnswers[q.id] || userAnswers[String(q.id)] || corrAns).toUpperCase().trim();
    const isQCorrect = (userAns === corrAns);

    let optionsHtml = '';
    const rawOpts = q.options || {};
    const optEntries = Array.isArray(rawOpts)
      ? rawOpts.map((opt, i) => [String.fromCharCode(65 + i), opt])
      : Object.entries(rawOpts);

    optEntries.forEach(([key, optVal]) => {
      const k = key.toUpperCase().trim();
      const isCorr = (k === corrAns);
      const isUser = (k === userAns);

      let markBadge = '';
      let optClass = 'option-row';

      if (isAttempted) {
        if (isCorr && isUser) {
          markBadge = '<span class="tick-correct">✔ (Correct &amp; Chosen)</span>';
          optClass += ' option-chosen-correct';
        } else if (isCorr && !isUser) {
          markBadge = '<span class="tick-correct">✔ (Correct Answer)</span>';
        } else if (isUser && !isCorr) {
          markBadge = '<span class="tick-wrong">✘ (Chosen Answer)</span>';
          optClass += ' option-chosen-wrong';
        }
      }

      optionsHtml += `
        <div class="${optClass}">
          <span class="opt-label">${k}.</span>
          <span class="opt-text">${escapeHtml(optVal)}</span>
          ${markBadge}
        </div>
      `;
    });

    questionsHtml += `
      <div class="question-card">
        <div class="question-title">
          <span class="q-num">Q${qNum}.</span>
          <span class="q-text">${qText}</span>
        </div>
        <div class="options-container">
          ${optionsHtml}
        </div>
      </div>
    `;
  });

  // OJT Criteria Table Rows (Support both checkpoints and criteria)
  let criteriaList = [];
  if (ojtTmpl && Array.isArray(ojtTmpl.checkpoints) && ojtTmpl.checkpoints.length > 0) {
    criteriaList = ojtTmpl.checkpoints.slice(0, 15).map(cp => ({
      code: String(cp.sno).padStart(2, '0'),
      parameter: cp.text || `Checkpoint ${cp.sno}`,
      method: 'Observation & Audit',
      standard: '100% adherence to SOP/WI',
      max: 5
    }));
  } else if (ojtTmpl && Array.isArray(ojtTmpl.criteria) && ojtTmpl.criteria.length > 0) {
    criteriaList = ojtTmpl.criteria.slice(0, 15);
  } else {
    criteriaList = [
      { code: '01', parameter: 'Machine & Area Safety Inspection', method: 'Observation & Practical Check', standard: 'Zero unsafe conditions', max: 5 },
      { code: '02', parameter: 'Raw Material Verification against Spec', method: 'Visual & Vernier Measurement', standard: '100% adherence to standard', max: 5 },
      { code: '03', parameter: 'Equipment Start-up & Initial Parameter Check', method: 'Checksheet audit', standard: 'Within specified limits', max: 5 },
      { code: '04', parameter: 'Building / Curing Operational Skill', method: 'Machine Run & Observation', standard: 'Cycle time & quality spec met', max: 10 },
      { code: '05', parameter: 'Defect Detection & Quarantine Procedure', method: 'Defect sample challenge', standard: '100% detection rate', max: 10 },
      { code: '06', parameter: 'Housekeeping (5S) and Cleanliness', method: 'Workplace audit', standard: 'All items in designated zones', max: 5 },
      { code: '07', parameter: 'Final Finishing & Visual Inspection Verification', method: 'Finished product audit', standard: 'Zero defects passed', max: 10 }
    ];
  }

  const ojtScores = ojtRec.scores || {};
  let ojtRowsHtml = '';
  let ojtTotal = 0;
  let ojtMaxTotal = 0;

  criteriaList.forEach((c, idx) => {
    const max = Number(c.max || c.maxMarks || 5);
    const scoreVal = (ojtScores[c.code] !== undefined)
      ? Number(ojtScores[c.code])
      : (ojtRec.totalScore ? Math.round((Number(ojtRec.totalScore) / (ojtRec.maxScore || 50)) * max) : max);
    
    ojtTotal += scoreVal;
    ojtMaxTotal += max;

    ojtRowsHtml += `
      <tr>
        <td style="text-align: center; font-weight: bold;">${idx + 1}</td>
        <td><strong>${escapeHtml(c.parameter || c.desc || 'Operational Check')}</strong></td>
        <td>${escapeHtml(c.method || 'Practical Inspection')}</td>
        <td>${escapeHtml(c.standard || 'As per ATC Standard')}</td>
        <td style="text-align: center;">${max}</td>
        <td style="text-align: center; font-weight: bold; color: #166534;">${scoreVal}</td>
      </tr>
    `;
  });

  if (ojtRec.totalScore !== undefined) {
    ojtTotal = ojtRec.totalScore;
  }
  if (ojtRec.maxScore !== undefined) {
    ojtMaxTotal = ojtRec.maxScore;
  }
  const isOjtPass = ojtTotal >= (ojtMaxTotal * 0.7);
  const ojtStatus = ojtRec.qualificationStatus || (isOjtPass ? 'Qualified' : 'Not Qualified');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ILUO Assessment Report - ${empNo}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 14mm 12mm 14mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      color: #0F172A;
      margin: 0;
      padding: 0;
      font-size: 9.5pt;
      line-height: 1.35;
      background: #FFFFFF;
    }

    /* Header Banner */
    .header-table {
      width: 100%;
      border-collapse: collapse;
      border: 2px solid #005B9E;
      margin-bottom: 12px;
      background: #F8FAFC;
    }
    .header-table td {
      padding: 8px 12px;
      vertical-align: middle;
      border: none;
    }
    .header-title-box {
      text-align: center;
    }
    .company-title {
      font-size: 14pt;
      font-weight: 800;
      color: #005B9E;
      letter-spacing: 0.5px;
      margin: 0;
      text-transform: uppercase;
    }
    .company-subtitle {
      font-size: 9pt;
      font-weight: bold;
      color: #334155;
      margin: 2px 0 0 0;
      text-transform: uppercase;
    }
    .report-badge {
      font-size: 10.5pt;
      font-weight: 800;
      color: #C00000;
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* Candidate Info Table */
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
      font-size: 9pt;
    }
    .meta-table td, .meta-table th {
      border: 1px solid #CBD5E1;
      padding: 5px 8px;
    }
    .meta-label {
      background: #F1F5F9;
      font-weight: 700;
      color: #334155;
      width: 18%;
      text-transform: uppercase;
    }
    .meta-val {
      font-weight: 600;
      color: #0F172A;
      width: 32%;
    }

    /* Section Category Header */
    .category-header {
      background: #1E3A8A;
      color: #FFFFFF;
      font-weight: 800;
      font-size: 9.5pt;
      padding: 4px 10px;
      margin: 12px 0 8px 0;
      text-transform: uppercase;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }

    /* Questions */
    .question-card {
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed #E2E8F0;
      page-break-inside: avoid;
    }
    .question-title {
      font-weight: 700;
      color: #0F172A;
      font-size: 9.5pt;
      margin-bottom: 4px;
      display: flex;
      gap: 6px;
    }
    .q-num {
      color: #005B9E;
      font-weight: 800;
      flex-shrink: 0;
    }
    .q-text {
      flex-grow: 1;
    }
    .options-container {
      margin-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .option-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 9pt;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .opt-label {
      font-weight: bold;
      color: #475569;
      width: 18px;
    }
    .opt-text {
      color: #1E293B;
      flex-grow: 1;
    }
    .tick-correct {
      color: #166534;
      font-weight: 800;
      font-size: 8.5pt;
      background: #DCFCE7;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid #86EFAC;
    }
    .tick-wrong {
      color: #991B1B;
      font-weight: 800;
      font-size: 8.5pt;
      background: #FEE2E2;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid #FCA5A5;
    }
    .option-chosen-correct {
      background: #F0FDF4;
      border-left: 3px solid #16A34A;
    }
    .option-chosen-wrong {
      background: #FEF2F2;
      border-left: 3px solid #DC2626;
    }

    /* Score Summary Box */
    .summary-card {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      page-break-inside: avoid;
    }
    .summary-card td {
      border: 1.5px solid #005B9E;
      padding: 8px 12px;
      text-align: center;
      font-size: 9pt;
    }
    .summary-title {
      background: #005B9E;
      color: white;
      font-weight: 800;
      text-transform: uppercase;
      font-size: 9.5pt;
    }

    /* OJT Section Break */
    .ojt-page {
      page-break-before: always;
      margin-top: 15px;
    }
    .ojt-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 8.5pt;
    }
    .ojt-table th {
      background: #005B9E;
      color: white;
      font-weight: bold;
      border: 1px solid #003B6F;
      padding: 6px;
      text-align: center;
      text-transform: uppercase;
    }
    .ojt-table td {
      border: 1px solid #CBD5E1;
      padding: 5px 6px;
      vertical-align: middle;
    }

    /* Signatures Table */
    .sign-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 18px;
      page-break-inside: avoid;
    }
    .sign-table td {
      border: 1px solid #94A3B8;
      padding: 10px 8px 4px 8px;
      width: 25%;
      text-align: center;
      font-size: 8.5pt;
      vertical-align: bottom;
    }
    .sign-title {
      font-weight: 700;
      color: #334155;
      text-transform: uppercase;
      margin-top: 25px;
      border-top: 1px dashed #64748B;
      padding-top: 4px;
    }
  </style>
</head>
<body>

  <!-- Official Header Banner -->
  <table class="header-table">
    <tr>
      <td style="width: 100px; text-align: left;">
        ${logoBase64 ? `<img src="${logoBase64}" style="height: 48px; max-width: 110px; object-fit: contain;">` : '<strong style="color:#C00000; font-size:16pt; font-family:impact;">ATC TIRES</strong>'}
      </td>
      <td class="header-title-box">
        <div class="company-title">ATC TIRES PRIVATE LIMITED</div>
        <div class="company-subtitle">TN PLANT - QUALITY ASSURANCE DEPARTMENT</div>
        <div class="report-badge">Assessment Questionnaire for '${tgtLevel}' Level Certification - ${section}</div>
      </td>
      <td style="width: 100px; text-align: right; font-size: 8pt; color: #64748B;">
        Doc: ATC/QA/ILUO<br>
        Rev: 04<br>
        Status: Official
      </td>
    </tr>
  </table>

  <!-- Candidate Details Table -->
  <table class="meta-table">
    <tr>
      <td class="meta-label">Employee Name</td>
      <td class="meta-val"><strong>${name}</strong></td>
      <td class="meta-label">Employee No</td>
      <td class="meta-val"><strong>${empNo}</strong></td>
    </tr>
    <tr>
      <td class="meta-label">Department</td>
      <td class="meta-val">${dept}</td>
      <td class="meta-label">Date of Joining</td>
      <td class="meta-val">${doj}</td>
    </tr>
    <tr>
      <td class="meta-label">Section</td>
      <td class="meta-val">${section}</td>
      <td class="meta-label">Assessment Date</td>
      <td class="meta-val">${date}</td>
    </tr>
    <tr>
      <td class="meta-label">Qualification Level</td>
      <td class="meta-val"><strong>${curLevel} Level &rarr; Target ${tgtLevel} Level</strong></td>
      <td class="meta-label">Assessment Result</td>
      <td class="meta-val"><strong style="color: ${isAttempted ? (isPass ? '#166534' : '#DC2626') : '#D97706'};">${isAttempted ? `${examStatus} (${totalMark} / 30 Marks - ${markPct}%)` : 'Pending Exam'}</strong></td>
    </tr>
  </table>

  <!-- Theory Assessment Questions -->
  <div style="font-weight: 800; font-size: 10.5pt; color: #005B9E; margin-bottom: 6px; text-transform: uppercase; border-bottom: 2px solid #005B9E; padding-bottom: 3px;">
    Part 1: Theoretical Assessment &amp; Quality Knowledge Verification (30 Multiple Choice Questions)
  </div>

  ${questionsHtml}

  <!-- Theory Score Summary Box -->
  <table class="summary-card">
    <tr class="summary-title">
      <td>Total Questions</td>
      <td>Passing Marks</td>
      <td>Marks Obtained</td>
      <td>Percentage</td>
      <td>Overall Qualification</td>
    </tr>
    <tr style="font-weight: 700; background: #F8FAFC;">
      <td>30</td>
      <td>21 / 30 (70%)</td>
      <td style="color: ${isAttempted ? (isPass ? '#166534' : '#DC2626') : '#64748B'}; font-size: 11pt;">${marksDisplay}</td>
      <td>${isAttempted ? `${markPct}%` : '-'}</td>
      <td style="color: ${isAttempted ? (isPass ? '#166534' : '#DC2626') : '#D97706'}; font-size: 10pt; text-transform: uppercase;">${isAttempted ? (isPass ? 'QUALIFIED FOR LEVEL PROMOTION' : 'RETEST REQUIRED') : 'PENDING ASSESSMENT'}</td>
    </tr>
  </table>

  <!-- Assessment Signatures -->
  <table class="sign-table">
    <tr>
      <td>
        ${record && record.candidateSignature ? `<img src="${record.candidateSignature}" alt="Candidate Signature" style="max-height: 40px; max-width: 120px; object-fit: contain; display: block; margin: 0 auto 4px auto;">` : ''}
        <div class="sign-title">Candidate Signature</div>
      </td>
      <td>
        <div class="sign-title">Evaluator Signature</div>
      </td>
      <td>
        <div class="sign-title">Section In-Charge</div>
      </td>
      <td>
        <div class="sign-title">Plant HR / QA Head</div>
      </td>
    </tr>
  </table>

  <!-- On The Job Training Evaluation Section (OJT) -->
  <div class="ojt-page">
    <table class="header-table">
      <tr>
        <td style="width: 100px; text-align: left;">
          ${logoBase64 ? `<img src="${logoBase64}" style="height: 44px; max-width: 100px; object-fit: contain;">` : '<strong style="color:#C00000; font-size:15pt; font-family:impact;">ATC TIRES</strong>'}
        </td>
        <td class="header-title-box">
          <div class="company-title">ATC TIRES PRIVATE LIMITED</div>
          <div class="company-subtitle">TN PLANT - INDIVIDUAL ON THE JOB TRAINING (OJT) EVALUATION</div>
          <div class="report-badge">${section} - Operational Skill Assessment</div>
        </td>
        <td style="width: 100px; text-align: right; font-size: 8pt; color: #64748B;">
          Form: OJT-EVAL<br>
          Rev: 03
        </td>
      </tr>
    </table>

    <table class="meta-table">
      <tr>
        <td class="meta-label">Associate Name</td>
        <td class="meta-val"><strong>${name}</strong></td>
        <td class="meta-label">Associate ID</td>
        <td class="meta-val"><strong>${empNo}</strong></td>
      </tr>
      <tr>
        <td class="meta-label">Section &amp; Process</td>
        <td class="meta-val">${section}</td>
        <td class="meta-label">Evaluation Date</td>
        <td class="meta-val">${date}</td>
      </tr>
      <tr>
        <td class="meta-label">Evaluator / Supervisor</td>
        <td class="meta-val">Section Supervisor / QA Auditor</td>
        <td class="meta-label">Practical OJT Status</td>
        <td class="meta-val"><strong style="color: #166534;">${escapeHtml(ojtStatus)} (${ojtTotal} / ${ojtMaxTotal} Marks)</strong></td>
      </tr>
    </table>

    <div style="font-weight: 800; font-size: 10pt; color: #005B9E; margin: 10px 0 6px 0; text-transform: uppercase;">
      Part 2: Shop-Floor Practical Evaluation &amp; Machine Parameter Verification
    </div>

    <table class="ojt-table">
      <thead>
        <tr>
          <th style="width: 40px;">S.No</th>
          <th>Evaluation Checkpoint &amp; Operational Parameter</th>
          <th style="width: 140px;">Evaluation Method</th>
          <th style="width: 180px;">Standard Parameter</th>
          <th style="width: 60px;">Max</th>
          <th style="width: 60px;">Awarded</th>
        </tr>
      </thead>
      <tbody>
        ${ojtRowsHtml}
        <tr style="background: #F1F5F9; font-weight: bold; font-size: 9pt;">
          <td colspan="4" style="text-align: right; text-transform: uppercase;">Total Practical OJT Score:</td>
          <td style="text-align: center;">${ojtMaxTotal}</td>
          <td style="text-align: center; color: #166534; font-size: 10pt;">${ojtTotal}</td>
        </tr>
      </tbody>
    </table>

    <!-- OJT Signatures -->
    <table class="sign-table" style="margin-top: 25px;">
      <tr>
        <td>
          <div class="sign-title">Associate Signature</div>
        </td>
        <td>
          <div class="sign-title">OJT Trainer / Evaluator</div>
        </td>
        <td>
          <div class="sign-title">Shift In-Charge</div>
        </td>
        <td>
          <div class="sign-title">Department Head (QA)</div>
        </td>
      </tr>
    </table>
  </div>

</body>
</html>
  `;
}

function generateSectionSummaryReportHtml(payload = {}) {
  const scope = String(payload.scope || 'PRODUCTION').toUpperCase();
  const departmentLabel = escapeHtml(
    payload.departmentLabel ||
    (scope === 'QA' ? 'Quality Control (8 QA Sections)' : scope === 'ALL' ? 'Plant-Wide Summary (Production & Quality Control)' : 'Production Department (25 Sections)')
  );
  const generatedAt = escapeHtml(payload.generatedAt || new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }));
  const logoBase64 = payload.logoBase64 || '';
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const totals = payload.totals || {
    total: 0, examDone: 0, examPassed: 0, ojtDone: 0, ojtPassed: 0, bothDone: 0, bothPassed: 0, pending: 0, completionPct: 0
  };
  const levelBreakdown = payload.levelBreakdown || { I: 0, L: 0, U: 0, O: 0 };
  const leftCount = Number(payload.leftCount || 0);

  const totalEmps = Number(totals.total || 0);
  const pctOf = (n) => (totalEmps > 0 ? Math.round((Number(n || 0) / totalEmps) * 100) : 0);

  const levelCards = ['I', 'L', 'U', 'O'].map((lvl) => {
    const cnt = Number(levelBreakdown[lvl] || 0);
    const pct = pctOf(cnt);
    const meta = {
      I: { title: 'Level I · Induction', color: '#475569', bg: '#F8FAFC', border: '#CBD5E1' },
      L: { title: 'Level L · Learner', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
      U: { title: 'Level U · Executor', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
      O: { title: 'Level O · Expert', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' }
    }[lvl];
    return `
      <div style="flex:1; background:${meta.bg}; border:1px solid ${meta.border}; border-radius:6px; padding:8px 10px;">
        <div style="font-size:7.5pt; font-weight:700; color:${meta.color}; text-transform:uppercase;">${meta.title}</div>
        <div style="font-size:13pt; font-weight:800; color:#0F172A; font-variant-numeric:tabular-nums; margin-top:2px;">
          ${cnt} <span style="font-size:8.5pt; font-weight:600; color:#64748B;">(${pct}%)</span>
        </div>
      </div>
    `;
  }).join('');

  const rowsHtml = sections.length > 0 ? sections.map((sec, idx) => {
    const t = Number(sec.total || 0);
    const eDone = Number(sec.examDone || 0);
    const ePass = Number(sec.examPassed || 0);
    const oDone = Number(sec.ojtDone || 0);
    const oPass = Number(sec.ojtPassed || 0);
    const bDone = Number(sec.bothDone || 0);
    const pend = Number(sec.pending !== undefined ? sec.pending : Math.max(0, t - bDone));
    const pct = Number(sec.completionPct !== undefined ? sec.completionPct : (t > 0 ? Math.round((bDone / t) * 100) : 0));
    const barColor = pct >= 90 ? '#059669' : pct >= 60 ? '#0284C7' : pct > 0 ? '#D97706' : '#94A3B8';
    const deptBadge = scope === 'ALL' && sec.deptGroup
      ? `<div style="font-size:7pt; color:#64748B; font-weight:600;">${escapeHtml(sec.deptGroup)}</div>`
      : '';

    return `
      <tr style="background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'}; page-break-inside:avoid;">
        <td style="text-align:center; font-weight:700; color:#475569;">${idx + 1}</td>
        <td style="font-weight:700; color:#0F172A;">
          ${escapeHtml(sec.name || sec.title || '-')}
          ${deptBadge}
        </td>
        <td style="text-align:center; font-weight:700;">${t}</td>
        <td style="text-align:center;">${eDone} / ${t}</td>
        <td style="text-align:center; color:#166534; font-weight:600;">${ePass}</td>
        <td style="text-align:center;">${oDone} / ${t}</td>
        <td style="text-align:center; color:#166534; font-weight:600;">${oPass}</td>
        <td style="text-align:center; font-weight:700; color:#1E40AF;">${bDone} / ${t}</td>
        <td style="text-align:center; color:${pend > 0 ? '#B45309' : '#059669'}; font-weight:600;">${pend}</td>
        <td>
          <div style="display:flex; align-items:center; gap:6px;">
            <div style="flex:1; height:7px; background:#E2E8F0; border-radius:4px; overflow:hidden;">
              <div style="width:${Math.min(100, Math.max(0, pct))}%; height:100%; background:${barColor};"></div>
            </div>
            <span style="min-width:32px; text-align:right; font-weight:800; color:#0F172A;">${pct}%</span>
          </div>
        </td>
      </tr>
    `;
  }).join('') : `
    <tr>
      <td colspan="10" style="text-align:center; padding:18px; color:#64748B;">No active sections found for the selected scope.</td>
    </tr>
  `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Yokohama ILUO Section Completion Summary</title>
  <style>
    @page { size: A4 portrait; margin: 10mm 11mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      color: #0F172A;
      background: #FFFFFF;
      margin: 0;
      padding: 0;
      font-size: 8.5pt;
      line-height: 1.35;
      font-variant-numeric: tabular-nums;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2.5px solid #005B9E;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .brand-block { display: flex; align-items: center; gap: 10px; }
    .brand-logo { max-height: 36px; max-width: 130px; object-fit: contain; }
    .report-title { font-size: 13pt; font-weight: 800; color: #0F172A; margin: 0; }
    .report-sub { font-size: 8.2pt; color: #475569; margin-top: 2px; font-weight: 600; }
    .meta-right { text-align: right; font-size: 7.6pt; color: #475569; }
    .kpi-grid { display: flex; gap: 7px; margin-bottom: 8px; }
    .kpi-box {
      flex: 1;
      border: 1px solid #CBD5E1;
      border-radius: 6px;
      padding: 6px 8px;
      background: #F8FAFC;
    }
    .kpi-label { font-size: 7pt; text-transform: uppercase; font-weight: 700; color: #475569; letter-spacing: 0.3px; }
    .kpi-val { font-size: 13pt; font-weight: 800; color: #005B9E; margin-top: 2px; }
    .kpi-sub { font-size: 7.2pt; color: #64748B; font-weight: 600; }
    .section-heading {
      font-size: 9pt;
      font-weight: 800;
      color: #0F172A;
      margin: 9px 0 5px 0;
      padding-bottom: 3px;
      border-bottom: 1px solid #E2E8F0;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    table.summary-table { width: 100%; border-collapse: collapse; font-size: 7.8pt; }
    table.summary-table thead { display: table-header-group; }
    table.summary-table th {
      background: #0F172A;
      color: #FFFFFF;
      padding: 5px 5px;
      font-weight: 700;
      text-align: left;
      border: 1px solid #0F172A;
      font-size: 7.3pt;
    }
    table.summary-table td {
      padding: 3.5px 5px;
      border: 1px solid #CBD5E1;
      vertical-align: middle;
    }
    table.summary-table tfoot td {
      background: #EFF6FF;
      font-weight: 800;
      color: #0F172A;
      border-top: 2px solid #005B9E;
      padding: 5.5px 5px;
    }
    .footer-note {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid #E2E8F0;
      display: flex;
      justify-content: space-between;
      font-size: 7.2pt;
      color: #64748B;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-block">
      ${logoBase64 ? `<img src="${logoBase64}" alt="Yokohama" class="brand-logo">` : ''}
      <div>
        <h1 class="report-title">ILUO Skill Assessment &amp; Section Completion Summary</h1>
        <div class="report-sub">${departmentLabel} &middot; ${sections.length} Sections Tracked</div>
      </div>
    </div>
    <div class="meta-right">
      <div><strong>Generated:</strong> ${generatedAt}</div>
      <div><strong>Plant:</strong> Yokohama ATC Tires</div>
      <div><strong>Active Headcount:</strong> ${totalEmps} (${leftCount} Left excluded)</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-box">
      <div class="kpi-label">Active Employees</div>
      <div class="kpi-val">${totalEmps}</div>
      <div class="kpi-sub">Across ${sections.length} sections</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">MCQ Exam Done</div>
      <div class="kpi-val" style="color:#0284C7;">${totals.examDone || 0}</div>
      <div class="kpi-sub">${pctOf(totals.examDone)}% of active &middot; ${totals.examPassed || 0} Passed</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Skill Assessment Done</div>
      <div class="kpi-val" style="color:#059669;">${totals.ojtDone || 0}</div>
      <div class="kpi-sub">${pctOf(totals.ojtDone)}% of active &middot; ${totals.ojtPassed || 0} Qualified</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Both Completed</div>
      <div class="kpi-val" style="color:#1E40AF;">${totals.bothDone || 0}</div>
      <div class="kpi-sub">${totals.completionPct || 0}% section completion</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Pending Completion</div>
      <div class="kpi-val" style="color:${Number(totals.pending || 0) > 0 ? '#D97706' : '#059669'};">${totals.pending || 0}</div>
      <div class="kpi-sub">${totals.bothPassed || 0} Fully Qualified</div>
    </div>
  </div>

  <div class="section-heading">Current Skill Level Distribution (Active Headcount)</div>
  <div style="display:flex; gap:8px; margin-bottom:10px;">
    ${levelCards}
  </div>

  <div class="section-heading">Section-Wise Completion Breakdown</div>
  <table class="summary-table">
    <thead>
      <tr>
        <th style="width:32px; text-align:center;">S.No</th>
        <th>Section Name</th>
        <th style="width:52px; text-align:center;">Active</th>
        <th style="width:68px; text-align:center;">MCQ Done</th>
        <th style="width:54px; text-align:center;">MCQ Pass</th>
        <th style="width:68px; text-align:center;">Skill Done</th>
        <th style="width:54px; text-align:center;">Skill Pass</th>
        <th style="width:68px; text-align:center;">Both Done</th>
        <th style="width:50px; text-align:center;">Pending</th>
        <th style="width:115px;">Completion %</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="text-align:right; text-transform:uppercase;">Total (${sections.length} Sections)</td>
        <td style="text-align:center;">${totalEmps}</td>
        <td style="text-align:center;">${totals.examDone || 0} / ${totalEmps}</td>
        <td style="text-align:center; color:#166534;">${totals.examPassed || 0}</td>
        <td style="text-align:center;">${totals.ojtDone || 0} / ${totalEmps}</td>
        <td style="text-align:center; color:#166534;">${totals.ojtPassed || 0}</td>
        <td style="text-align:center; color:#1E40AF;">${totals.bothDone || 0} / ${totalEmps}</td>
        <td style="text-align:center;">${totals.pending || 0}</td>
        <td>
          <div style="display:flex; align-items:center; gap:6px;">
            <div style="flex:1; height:7px; background:#CBD5E1; border-radius:4px; overflow:hidden;">
              <div style="width:${Math.min(100, Math.max(0, Number(totals.completionPct || 0)))}%; height:100%; background:#005B9E;"></div>
            </div>
            <span style="min-width:32px; text-align:right; font-weight:800;">${totals.completionPct || 0}%</span>
          </div>
        </td>
      </tr>
    </tfoot>
  </table>

  <div class="footer-note">
    <span>Yokohama ATC Tires &middot; Official ILUO Skill Assessment Portal</span>
    <span>Computer-generated executive summary &middot; Page size A4</span>
  </div>
</body>
</html>
  `;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateOfficialReportHtml, generateSectionSummaryReportHtml };
}
if (typeof window !== 'undefined') {
  window.generateOfficialReportHtml = generateOfficialReportHtml;
  window.generateSectionSummaryReportHtml = generateSectionSummaryReportHtml;
}
