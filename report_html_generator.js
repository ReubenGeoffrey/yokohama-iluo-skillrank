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

  const questionsToRender = (qbQuestions && qbQuestions.length > 0) ? qbQuestions : [
    { id: 1, category: 'Safety', text: 'What is safety? / பாதுகாப்பு என்றால் என்ன?', options: { A: 'To prevent injury and ill health', B: 'Getting injury', C: 'Performing unsafe act', D: 'Exposure to unsafe condition' }, answer: 'A' },
    { id: 2, category: 'Safety', text: 'What is PPE? / PPE என்றால் என்ன?', options: { A: 'Personal Performance Equipment', B: 'People Performance Equipment', C: 'Personal Process Equipment', D: 'Personal Protective Equipment' }, answer: 'D' },
    { id: 3, category: 'CI & TPM', text: 'Which step of the 5S methodology involves identifying and labeling items?', options: { A: 'Sort', B: 'Set in Order', C: 'Shine', D: 'Standardize' }, answer: 'B' }
  ];

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

  // OJT Criteria Table Rows
  const criteriaList = (ojtTmpl && ojtTmpl.criteria && ojtTmpl.criteria.length > 0)
    ? ojtTmpl.criteria
    : [
        { code: '01', parameter: 'Machine & Area Safety Inspection', method: 'Observation & Practical Check', standard: 'Zero unsafe conditions', max: 5 },
        { code: '02', parameter: 'Raw Material Verification against Spec', method: 'Visual & Vernier Measurement', standard: '100% adherence to standard', max: 5 },
        { code: '03', parameter: 'Equipment Start-up & Initial Parameter Check', method: 'Checksheet audit', standard: 'Within specified limits', max: 5 },
        { code: '04', parameter: 'Building / Curing Operational Skill', method: 'Machine Run & Observation', standard: 'Cycle time & quality spec met', max: 10 },
        { code: '05', parameter: 'Defect Detection & Quarantine Procedure', method: 'Defect sample challenge', standard: '100% detection rate', max: 10 },
        { code: '06', parameter: 'Housekeeping (5S) and Cleanliness', method: 'Workplace audit', standard: 'All items in designated zones', max: 5 },
        { code: '07', parameter: 'Final Finishing & Visual Inspection Verification', method: 'Finished product audit', standard: 'Zero defects passed', max: 10 }
      ];

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
        <td>${escapeHtml(c.standard || 'As per Yokohama ATC Standard')}</td>
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
  <title>Yokohama ILUO Assessment Report - ${empNo}</title>
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
        ${logoBase64 ? `<img src="${logoBase64}" style="height: 48px; max-width: 110px; object-fit: contain;">` : '<strong style="color:#C00000; font-size:16pt; font-family:impact;">YOKOHAMA</strong>'}
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
          ${logoBase64 ? `<img src="${logoBase64}" style="height: 44px; max-width: 100px; object-fit: contain;">` : '<strong style="color:#C00000; font-size:15pt; font-family:impact;">YOKOHAMA</strong>'}
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
          <th style="width: 180px;">Yokohama Standard</th>
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

module.exports = { generateOfficialReportHtml };
