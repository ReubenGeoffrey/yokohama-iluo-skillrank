// =====================================================================
// OFFICIAL ASSESSMENT & OJT REPORT HTML GENERATOR
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
        ${examRecord && examRecord.candidateSignature ? `<img src="${examRecord.candidateSignature}" alt="Candidate Signature" style="max-height: 40px; max-width: 120px; object-fit: contain; display: block; margin: 0 auto 4px auto;">` : ''}
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

// =====================================================================
// EXECUTIVE DEPARTMENT COMPETENCY SUMMARY REPORT HTML GENERATOR
// Landscape A4 audit-ready layout compliant with ISO/IATF 16949
// =====================================================================
function generateDepartmentSummaryHtml(options = {}) {
  const dept = (options.dept || 'PRODUCTION').toUpperCase().trim();
  const allEmployees = options.employees || [];
  const records = options.records || {};
  const ojtRecords = options.ojtRecords || {};
  const sections = options.sections || [];
  const logoBase64 = options.logoBase64 || '';
  const generatedDate = options.generatedDate || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const shift = options.shift || 'Shift 1 (06:00 - 14:00)';

  // Determine Department Titles & Scope
  let deptTitle = 'Production Department';
  let deptScopeBadge = '25 Manufacturing Sections • 1,179 Associates';
  let deptRef = 'PROD';
  let deptColor = '#6D28D9';
  let deptEmps = [];

  if (dept === 'PRODUCTION' || dept.includes('PROD')) {
    deptTitle = 'Production Department';
    deptScopeBadge = '25 Manufacturing Sections • 1,179 Associates';
    deptRef = 'PROD';
    deptColor = '#6D28D9';
    deptEmps = allEmployees.filter(e => (e.dept || '').toUpperCase().includes('PROD'));
  } else if (dept === 'QUALITY CONTROL' || dept === 'QUALITY' || dept.includes('QUAL')) {
    deptTitle = 'Quality Control Department';
    deptScopeBadge = '8 QA Sections • 283 Associates';
    deptRef = 'QA';
    deptColor = '#005B9E';
    deptEmps = allEmployees.filter(e => (e.dept || '').toUpperCase().includes('QUAL'));
  } else {
    deptTitle = 'All Plant Departments';
    deptScopeBadge = '33 Total Sections • 1,462 Associates';
    deptRef = 'PLANT';
    deptColor = '#0F172A';
    deptEmps = allEmployees;
  }

  const totalEmps = deptEmps.length;
  let examDone = 0;
  let ojtDone = 0;
  let bothDone = 0;
  let countI = 0, countL = 0, countU = 0, countO = 0;

  deptEmps.forEach(e => {
    const rec = records[e.empNo];
    const ojt = ojtRecords[e.empNo];
    const hasExam = rec && rec.isCompleted;
    const hasOjt = ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined);

    if (hasExam) examDone++;
    if (hasOjt) ojtDone++;
    if (hasExam && hasOjt) bothDone++;

    const lvl = (e.currentLevel || 'I').toUpperCase();
    if (lvl === 'I') countI++;
    else if (lvl === 'L') countL++;
    else if (lvl === 'U') countU++;
    else if (lvl === 'O') countO++;
  });

  const examPct = totalEmps > 0 ? Math.round((examDone / totalEmps) * 100) : 0;
  const ojtPct = totalEmps > 0 ? Math.round((ojtDone / totalEmps) * 100) : 0;
  const bothPct = totalEmps > 0 ? Math.round((bothDone / totalEmps) * 100) : 0;
  const tniCount = countI + countL; // Training Needs Identified (Level I & L needing elevation to Level U)

  // Build Section Rows
  let tableRowsHtml = '';
  let grandTotalEmps = 0;
  let grandTotalI = 0, grandTotalL = 0, grandTotalU = 0, grandTotalO = 0;
  let grandTotalExam = 0, grandTotalOjt = 0, grandTotalBoth = 0;

  sections.forEach((sec, idx) => {
    const normSec = (sec.normName || sec.name || '').toLowerCase().trim();
    const sEmps = deptEmps.filter(e => {
      const eSec = (e.section || '').toLowerCase().trim();
      return eSec === normSec || eSec === (sec.name || '').toLowerCase().trim();
    });

    const sTotal = sEmps.length;
    let sExam = 0, sOjt = 0, sBoth = 0;
    let sI = 0, sL = 0, sU = 0, sO = 0;

    sEmps.forEach(e => {
      const rec = records[e.empNo];
      const ojt = ojtRecords[e.empNo];
      const hasExam = rec && rec.isCompleted;
      const hasOjt = ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined);

      if (hasExam) sExam++;
      if (hasOjt) sOjt++;
      if (hasExam && hasOjt) sBoth++;

      const lvl = (e.currentLevel || 'I').toUpperCase();
      if (lvl === 'I') sI++;
      else if (lvl === 'L') sL++;
      else if (lvl === 'U') sU++;
      else if (lvl === 'O') sO++;
    });

    const sPct = sTotal > 0 ? Math.round((sBoth / sTotal) * 100) : 0;
    const isProd = (sec.dept === 'PRODUCTION') || (!sec.name.toLowerCase().includes('qa'));

    grandTotalEmps += sTotal;
    grandTotalI += sI;
    grandTotalL += sL;
    grandTotalU += sU;
    grandTotalO += sO;
    grandTotalExam += sExam;
    grandTotalOjt += sOjt;
    grandTotalBoth += sBoth;

    const progressColor = sPct >= 80 ? '#059669' : (sPct >= 50 ? '#0284C7' : '#D97706');

    tableRowsHtml += `
      <tr style="border-bottom: 1px solid #E2E8F0; ${idx % 2 === 1 ? 'background-color: #F8FAFC;' : ''}">
        <td style="text-align: center; font-weight: 700; color: #64748B; padding: 5px 4px;">${idx + 1}</td>
        <td style="text-align: center; padding: 5px 4px;">
          <span style="display: inline-block; padding: 2px 5px; font-size: 9px; font-weight: 800; border-radius: 3px; background: ${isProd ? '#EDE9FE' : '#EFF6FF'}; color: ${isProd ? '#6D28D9' : '#0284C7'}; border: 1px solid ${isProd ? '#DDD6FE' : '#BFDBFE'};">${escapeHtml(sec.code || 'SEC')}</span>
        </td>
        <td style="padding: 5px 6px; font-weight: 700; color: #0F172A;">
          ${escapeHtml(sec.title || sec.name)}
          <span style="font-size: 8.5px; font-weight: 400; color: #64748B; display: block;">${escapeHtml(sec.name)}</span>
        </td>
        <td style="text-align: center; font-weight: 700; padding: 5px 4px; font-variant-numeric: tabular-nums;">${sTotal}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #334155; font-weight: 600;">${sI}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #92400E; font-weight: 600;">${sL}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #1E40AF; font-weight: 600;">${sU}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #14532D; font-weight: 700;">${sO}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #0284C7; font-weight: 600;">${sExam} / ${sTotal}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #059669; font-weight: 600;">${sOjt} / ${sTotal}</td>
        <td style="text-align: center; padding: 5px 4px; font-variant-numeric: tabular-nums; color: #1E40AF; font-weight: 700;">${sBoth} / ${sTotal}</td>
        <td style="padding: 5px 6px;">
          <div style="display: flex; align-items: center; gap: 5px;">
            <div style="flex: 1; background: #E2E8F0; height: 6px; border-radius: 3px; overflow: hidden;">
              <div style="width: ${sPct}%; background: ${progressColor}; height: 100%;"></div>
            </div>
            <span style="font-size: 9.5px; font-weight: 800; min-width: 32px; text-align: right; color: #0F172A; font-variant-numeric: tabular-nums;">${sPct}%</span>
          </div>
        </td>
      </tr>
    `;
  });

  const grandPct = grandTotalEmps > 0 ? Math.round((grandTotalBoth / grandTotalEmps) * 100) : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ATC Tires — Department Summary Report (${escapeHtml(deptTitle)})</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 8mm 10mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 0;
      color: #0F172A;
      background: #FFFFFF;
      font-size: 10px;
      line-height: 1.35;
    }
    .report-page {
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      background: #FFFFFF;
    }
    .header-table {
      width: 100%;
      border-collapse: collapse;
      border-bottom: 2.5px solid #003D6B;
      padding-bottom: 8px;
      margin-bottom: 12px;
    }
    .header-table td {
      border: none;
      vertical-align: middle;
      padding: 4px 6px;
    }
    .kpi-grid {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .kpi-card {
      flex: 1;
      min-width: 0;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 6px;
      padding: 8px 12px;
      border-top: 3px solid #003D6B;
    }
    .kpi-title {
      font-size: 8.5px;
      font-weight: 700;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .kpi-val {
      font-size: 16px;
      font-weight: 800;
      color: #0F172A;
      margin: 2px 0;
      font-variant-numeric: tabular-nums;
    }
    .kpi-sub {
      font-size: 8.5px;
      color: #64748B;
    }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5px;
      margin-top: 6px;
      margin-bottom: 12px;
      page-break-inside: auto;
    }
    .summary-table th {
      background: #003D6B;
      color: #FFFFFF;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 8.5px;
      letter-spacing: 0.4px;
      padding: 6px 4px;
      border: 1px solid #002B4D;
      text-align: center;
    }
    .summary-table td {
      border: 1px solid #CBD5E1;
      padding: 4px 5px;
    }
    .summary-table tr {
      page-break-inside: avoid;
    }
    .grand-total-row {
      background: #0F172A !important;
      color: #FFFFFF !important;
      font-weight: 800;
      border-top: 2px solid #000000;
    }
    .grand-total-row td {
      border: 1px solid #0F172A;
      color: #FFFFFF !important;
      font-size: 10px;
      padding: 6px 4px;
    }
    .tni-box {
      background: #F8FAFC;
      border: 1px solid #CBD5E1;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    .sign-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      page-break-inside: avoid;
    }
    .sign-table td {
      width: 33.33%;
      border: 1px solid #CBD5E1;
      padding: 10px 12px;
      background: #FFFFFF;
      vertical-align: top;
    }
    .sign-label {
      font-size: 8.5px;
      font-weight: 700;
      color: #64748B;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .sign-role {
      font-size: 10px;
      font-weight: 800;
      color: #0F172A;
      margin-bottom: 24px;
    }
    .sign-line {
      border-top: 1px dashed #94A3B8;
      padding-top: 4px;
      display: flex;
      justify-content: space-between;
      font-size: 8.5px;
      color: #64748B;
    }
    .footer-bar {
      margin-top: 10px;
      padding-top: 6px;
      border-top: 1px solid #E2E8F0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 8px;
      color: #94A3B8;
    }
  </style>
</head>
<body>

  <div class="report-page">
    <!-- Official ATC Tires Header -->
    <table class="header-table">
      <tr>
        <td style="width: 160px;">
          ${logoBase64 ? `<img src="${logoBase64}" alt="ATC Tires" style="height: 42px; max-width: 155px; object-fit: contain;">` : `<div style="font-size: 18px; font-weight: 900; color: #003D6B; letter-spacing: 1px;">ATC TIRES</div>`}
        </td>
        <td style="text-align: center;">
          <div style="font-size: 15px; font-weight: 900; color: #0F172A; letter-spacing: 0.5px;">ATC TIRES PVT. LTD.</div>
          <div style="font-size: 9.5px; font-weight: 700; color: #D32F2F; letter-spacing: 0.8px; margin-top: 1px;">
            PLANT COMPETENCY &amp; VERIFICATION SYSTEM &bull; ISO 9001:2015 &amp; IATF 16949 COMPLIANT
          </div>
          <div style="font-size: 12.5px; font-weight: 800; color: #003D6B; margin-top: 3px; text-transform: uppercase;">
            EXECUTIVE DEPARTMENT COMPETENCY SUMMARY REPORT — ${escapeHtml(deptTitle.toUpperCase())}
          </div>
        </td>
        <td style="width: 200px; text-align: right; font-size: 8.5px; line-height: 1.4;">
          <div style="background: #F1F5F9; border: 1px solid #CBD5E1; border-radius: 4px; padding: 5px 8px; text-align: left; display: inline-block;">
            <div><strong>DOC REF:</strong> ATC/ILUO-${deptRef}/2026</div>
            <div><strong>IATF REV:</strong> 04 (Automotive Standard)</div>
            <div><strong>DATE:</strong> ${escapeHtml(generatedDate)}</div>
            <div><strong>SHIFT:</strong> ${escapeHtml(shift)}</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Executive KPI Summary Grid -->
    <div class="kpi-grid">
      <div class="kpi-card" style="border-top-color: #003D6B;">
        <div class="kpi-title">Total Headcount</div>
        <div class="kpi-val">${totalEmps.toLocaleString()}</div>
        <div class="kpi-sub">${escapeHtml(deptScopeBadge)}</div>
      </div>
      <div class="kpi-card" style="border-top-color: #0284C7;">
        <div class="kpi-title">Theory Exam Certified</div>
        <div class="kpi-val" style="color: #0284C7;">${examDone.toLocaleString()} <span style="font-size: 11px; font-weight: 600; color: #64748B;">(${examPct}%)</span></div>
        <div class="kpi-sub">30-MCQ Section Knowledge (Passing &ge; 70%)</div>
      </div>
      <div class="kpi-card" style="border-top-color: #059669;">
        <div class="kpi-title">Skill Assessment (OJT)</div>
        <div class="kpi-val" style="color: #059669;">${ojtDone.toLocaleString()} <span style="font-size: 11px; font-weight: 600; color: #64748B;">(${ojtPct}%)</span></div>
        <div class="kpi-sub">Shop-Floor Practical Rubric (Passing &ge; 75%)</div>
      </div>
      <div class="kpi-card" style="border-top-color: #7C3AED;">
        <div class="kpi-title">Fully Certified (Both Done)</div>
        <div class="kpi-val" style="color: #7C3AED;">${bothDone.toLocaleString()} <span style="font-size: 11px; font-weight: 600; color: #64748B;">(${bothPct}%)</span></div>
        <div class="kpi-sub">Dual-Qualified Associates (Exam + OJT)</div>
      </div>
    </div>

    <!-- Competency Level Mix Bar -->
    <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <div style="font-size: 8.5px; font-weight: 700; color: #475569; text-transform: uppercase;">
        ILUO Competency Breakdown:
      </div>
      <div style="display: flex; gap: 12px; align-items: center;">
        <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; color: #334155;">
          <span style="width: 14px; height: 14px; border-radius: 3px; background: #F1F5F9; color: #334155; border: 1px solid #94A3B8; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800;">I</span>
          Beginner: <strong>${countI}</strong> (${totalEmps > 0 ? Math.round((countI/totalEmps)*100) : 0}%)
        </span>
        <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; color: #92400E;">
          <span style="width: 14px; height: 14px; border-radius: 3px; background: #FEF3C7; color: #92400E; border: 1px solid #F59E0B; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800;">L</span>
          Learner: <strong>${countL}</strong> (${totalEmps > 0 ? Math.round((countL/totalEmps)*100) : 0}%)
        </span>
        <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; color: #1E40AF;">
          <span style="width: 14px; height: 14px; border-radius: 3px; background: #DBEAFE; color: #1E40AF; border: 1px solid #3B82F6; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800;">U</span>
          Executor: <strong>${countU}</strong> (${totalEmps > 0 ? Math.round((countU/totalEmps)*100) : 0}%)
        </span>
        <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 700; color: #14532D;">
          <span style="width: 14px; height: 14px; border-radius: 3px; background: #DCFCE7; color: #14532D; border: 1px solid #10B981; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800;">O</span>
          Expert: <strong>${countO}</strong> (${totalEmps > 0 ? Math.round((countO/totalEmps)*100) : 0}%)
        </span>
      </div>
      <div style="font-size: 9px; color: #64748B;">
        Autonomous Coverage (U + O): <strong>${totalEmps > 0 ? Math.round(((countU + countO) / totalEmps) * 100) : 0}%</strong>
      </div>
    </div>

    <!-- Section Breakdown Table -->
    <table class="summary-table">
      <thead>
        <tr>
          <th style="width: 32px;">S.No</th>
          <th style="width: 55px;">Code</th>
          <th style="text-align: left; padding-left: 8px;">Section Name</th>
          <th style="width: 65px;">Headcount</th>
          <th style="width: 48px;">Level I</th>
          <th style="width: 48px;">Level L</th>
          <th style="width: 48px;">Level U</th>
          <th style="width: 48px;">Level O</th>
          <th style="width: 78px;">Theory Exam</th>
          <th style="width: 78px;">Skill (OJT)</th>
          <th style="width: 82px;">Both Done</th>
          <th style="width: 105px;">Completion %</th>
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
        <!-- Grand Total Summary Row -->
        <tr class="grand-total-row">
          <td colspan="3" style="text-align: right; padding-right: 12px; font-weight: 800; font-size: 10.5px;">
            TOTAL (${sections.length} SECTIONS)
          </td>
          <td style="text-align: center; font-weight: 800; font-size: 10.5px; font-variant-numeric: tabular-nums;">${grandTotalEmps}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalI}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalL}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalU}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalO}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalExam} / ${grandTotalEmps}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalOjt} / ${grandTotalEmps}</td>
          <td style="text-align: center; font-weight: 800; font-variant-numeric: tabular-nums;">${grandTotalBoth} / ${grandTotalEmps}</td>
          <td style="text-align: center; font-weight: 800; font-size: 10.5px; font-variant-numeric: tabular-nums;">${grandPct}% DONE</td>
        </tr>
      </tbody>
    </table>

    <!-- Skill Gap & Training Needs Identification (TNI) Clause -->
    <div class="tni-box">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <span style="font-size: 9px; font-weight: 800; color: #003D6B; text-transform: uppercase; letter-spacing: 0.5px;">
          Skill Gap Analysis &amp; Training Action Plan (IATF 16949 Clause 7.2)
        </span>
        <span style="font-size: 8.5px; font-weight: 700; color: #D32F2F;">
          Training Needs Identified (TNI): ${tniCount} Associates (Level I &amp; L)
        </span>
      </div>
      <p style="margin: 0; font-size: 8.5px; color: #334155; line-height: 1.4;">
        In accordance with IATF 16949:2016 automotive standards and plant standard operating procedures, associates at <strong>Level I (Beginner)</strong> and <strong>Level L (Learner)</strong> are restricted to designated training lines under direct supervisory oversight. Targeted OJT progression programs are scheduled within 30 days to elevate qualifying operators to <strong>Level U (Autonomous)</strong>. All evaluation rubrics, safety verifications, and 30-MCQ knowledge scores are archived in the authoritative plant qualification ledger.
      </p>
    </div>

    <!-- Formal 3-Column Management Approval Block -->
    <table class="sign-table">
      <tr>
        <td>
          <div class="sign-label">Prepared &amp; Verified By</div>
          <div class="sign-role">Competency Evaluator / HR Lead</div>
          <div class="sign-line">
            <span>Signature: _______________________</span>
            <span>Date: ____________</span>
          </div>
        </td>
        <td>
          <div class="sign-label">Reviewed By</div>
          <div class="sign-role">Head of Department (HOD) — ${escapeHtml(deptTitle)}</div>
          <div class="sign-line">
            <span>Signature: _______________________</span>
            <span>Date: ____________</span>
          </div>
        </td>
        <td>
          <div class="sign-label">Approved By</div>
          <div class="sign-role">Plant Head / Quality Head (ATC Tires)</div>
          <div class="sign-line">
            <span>Signature: _______________________</span>
            <span>Date: ____________</span>
          </div>
        </td>
      </tr>
    </table>

    <!-- Footer Bar -->
    <div class="footer-bar">
      <span>ATC TIRES PVT. LTD. &bull; PLANT COMPETENCY SYSTEM</span>
      <span>AUTOMOTIVE TIRE MANUFACTURING &bull; CONFIDENTIAL &amp; PROPRIETARY</span>
      <span>ISO 9001:2015 &bull; IATF 16949 COMPLIANT REPORT</span>
    </div>
  </div>

</body>
</html>
  `;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateOfficialReportHtml, generateDepartmentSummaryHtml };
}
if (typeof window !== 'undefined') {
  window.generateOfficialReportHtml = generateOfficialReportHtml;
  window.generateDepartmentSummaryHtml = generateDepartmentSummaryHtml;
}
