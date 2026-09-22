// =====================================================================
// YOKOHAMA ILUO OFFICIAL DOCX REPORT GENERATOR (Universal Node & Browser)
// Generates official Word documents (.docx) matching exact QC specifications
// =====================================================================

(function (global) {
  'use strict';

  // Checkpoint definitions for all QA sections
  const OJT_CHECKPOINTS_MAP = {
    'tire_building': {
      formatNo: 'Format No: ATC/T/FOR/HR/87D',
      title: 'ON THE JOB TRAINING EVALUATION - TBM QA',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety,)'],
        [2, 'Machine cleanliness and material handling'],
        [3, 'Verification for BPR parameter & centering.'],
        [4, 'Verification of Drum parameter with filling of the drum change memo and FTC sheet.'],
        [5, 'Bottom / Back stitcher tool gap and play verification.'],
        [6, 'Verification on – NSNL /MES/SKU sticker and recipe /Guide light / Pressure gauge/ material Guider centering/ TCU temperature /Pokayoke'],
        [7, 'Material measurement and knowledge on measuring tool'],
        [8, 'Material direction (Ply/breaker/belt) or material positioning for uncommon size.'],
        [9, 'CC/ GT defect checking and NC material handling'],
        [10, 'TEI ( Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.,)']
      ]
    },
    'tire_curing': {
      formatNo: 'Format No: ATC/T/FOR/HR/88D',
      title: 'ON THE JOB TRAINING EVALUATION - TIRE CURING QA',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety & VCL )'],
        [2, 'Verification of Press parameters dome temperature, Pressure gauges, Tower lamp working condition , Bladder and sleeve height measurement (Equipment calibrations)'],
        [3, 'Verification on – NSNL /MES/Scanning and recipe'],
        [4, 'Verification of tire engraving covered as per route card'],
        [5, 'Cure cycle time verification as per specification'],
        [6, 'Verification of GT condition (Paint aging and application (Inner & outer)/ GT storage)'],
        [7, 'GT loading direction against route card'],
        [8, 'PCI machine pressure & flange width measurement (OD setting if applicable)'],
        [9, 'NC material handling'],
        [10, 'Knowledge of Measuring equipments Vernier caliper, Measuring tape, Steel rule, dial gauge and Lux meter.']
      ]
    },
    'warehouse': {
      formatNo: 'Format No: ATC/T/FOR/HR/89D',
      title: 'ON THE JOB TRAINING EVALUATION - WAREHOUSE QA',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety,)'],
        [2, 'Basic 5S on shop floor.'],
        [3, 'Precautions for forklift usage during tire loading inside the container.'],
        [4, 'OK tires and not ok tire identification and disposal.'],
        [5, 'Confirmation of PDI cleared tires.'],
        [6, 'Containment action and corrective action for customer complaints/feedbacks.'],
        [7, 'Aging requirements for outgoing product.'],
        [8, 'Poke Yoke in warehouse.'],
        [9, 'Purpose of bead vent/flash trimming on tubeless tires before dispatch.'],
        [10, 'TEI ( Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.,)']
      ]
    },
    'solid_tire': {
      formatNo: 'Format No: ATC/T/FOR/HR/86D',
      title: 'ON THE JOB TRAINING EVALUATION - SOLID TIRE QA',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Tire handling, Electrical safety & VCL)'],
        [2, 'Machine cleanliness and material handling'],
        [3, 'Band building parameter verification (Width, gauge, length & diameter)'],
        [4, 'Base & Tread extrusion profile and temperature verification'],
        [5, 'Press temperature and cure cycle verification'],
        [6, 'Visual inspection of cured solid tires & defect classification'],
        [7, 'Trimming and buffing quality check'],
        [8, 'Pokayoke verification in solid tire press & assembly'],
        [9, 'NC material handling & scrap segregation'],
        [10, 'TEI (Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.)']
      ]
    },
    'preparatory': {
      formatNo: 'Format No: ATC/T/FOR/HR/85D',
      title: 'ON THE JOB TRAINING EVALUATION - PREPARATORY QA',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Material handling, Emergency stops)'],
        [2, 'Raw material and compound receipt verification & FIFO maintenance'],
        [3, 'Calender line parameter check (Fabric tension, cord count, gum gauge)'],
        [4, 'Extruder temperature, screw speed & profile dimension control'],
        [5, 'Bead winding and apexing inspection (Bead diameter, apex height)'],
        [6, 'Slitting and cutting angle & width specification check'],
        [7, 'Storage condition & book aging tracking for rubber components'],
        [8, 'Handling and calibration of measuring instruments (Thickness gauge, vernier)'],
        [9, 'Non-conforming (NC) material identification & tagging'],
        [10, 'TEI (Knowledge of QCC, 5S, OPL, Kaizen, Suggestion etc.)']
      ]
    },
    'final_finish': {
      formatNo: 'Format No: ATC/T/FOR/HR/84D',
      title: 'ON THE JOB TRAINING EVALUATION - FINAL FINISH REPAIR ASSOCIATE',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Tire handling, Air tool safety)'],
        [2, 'Visual inspection techniques for surface defects (Bead, sidewall, tread)'],
        [3, 'Tire repair criteria assessment (Reparable vs Scrap criteria)'],
        [4, 'Buffing technique, tool selection and depth control'],
        [5, 'Chemical cement application and drying time control'],
        [6, 'Patch application, stitching, and curing parameter check'],
        [7, 'Post-repair inspection & quality sign-off']
      ]
    },
    'rro_alt': {
      formatNo: 'Format No: ATC/T/FOR/HR/83D',
      title: 'ON THE JOB TRAINING EVALUATION - RRO & ALT OPERATOR',
      checkpoints: [
        [1, 'Safety Awareness (BBs, PPE, Rotating machinery safety, Ergonomics)'],
        [2, 'Radial Runout (RRO) & Lateral Runout (LRO) measurement principles'],
        [3, 'Uniformity testing machine calibration & master tire verification'],
        [4, 'Inflation pressure settings and bead seating verification'],
        [5, 'Dynamic balancing procedure and weight placement accuracy'],
        [6, 'High-speed anomaly and force variation detection'],
        [7, 'Classification of tires (Grade A, Grade B, Re-check, Scrap)'],
        [8, 'Marking and data logging in MES/Quality portal']
      ]
    }
  };

  function normalizeSectionKey(sec) {
    const s = (sec || '').toLowerCase().trim().replace(/\s+/g, ' ').replace('ware house', 'warehouse');
    if (s.includes('rro') || s.includes('alt')) return 'rro_alt';
    if (s.includes('preparatory')) return 'preparatory';
    if (s.includes('solid')) return 'solid_tire';
    if (s.includes('building') || s.includes('tbm')) return 'tire_building';
    if (s.includes('curing')) return 'tire_curing';
    if (s.includes('warehouse') || s.includes('fid')) return 'warehouse';
    return 'final_finish';
  }

  function escapeXml(unsafe) {
    if (unsafe === undefined || unsafe === null) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function buildTableCell(text, opts) {
    const bold = opts && opts.bold ? '<w:b/>' : '';
    const color = opts && opts.color ? `<w:color w:val="${opts.color}"/>` : '<w:color w:val="0F172A"/>';
    const sz = opts && opts.sizePt ? `<w:sz w:val="${opts.sizePt * 2}"/>` : '<w:sz w:val="18"/>';
    const bg = opts && opts.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.bg}"/>` : '';
    const align = opts && opts.align ? opts.align : 'left';
    const width = opts && opts.width ? `<w:tcW w:w="${opts.width}" w:type="dxa"/>` : '';

    return `<w:tc>
      <w:tcPr>
        ${width}
        ${bg}
        <w:tcMar>
          <w:top w:w="80" w:type="dxa"/>
          <w:bottom w:w="80" w:type="dxa"/>
          <w:left w:w="120" w:type="dxa"/>
          <w:right w:w="120" w:type="dxa"/>
        </w:tcMar>
      </w:tcPr>
      <w:p>
        <w:pPr>
          <w:jc w:val="${align}"/>
          <w:spacing w:before="20" w:after="20"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
            ${bold}
            ${sz}
            ${color}
          </w:rPr>
          <w:t xml:space="preserve">${escapeXml(text)}</w:t>
        </w:r>
      </w:p>
    </w:tc>`;
  }

  function generateDocumentXml(data) {
    const { emp, examRecord, ojtRecord, logoRId } = data;

    const empName = emp.name || `Employee ${emp.empNo}`;
    const empNo = emp.empNo || '900000';
    const dept = emp.dept || 'QUALITY CONTROL';
    const section = emp.section || 'Tire building QA';
    const doj = emp.doj || '-';
    const targetLvl = (examRecord && examRecord.targetLevel) || emp.targetLevel || 'L';
    const attemptDate = (examRecord && examRecord.attemptDate) || new Date().toLocaleDateString('en-GB');

    const submittedQs = (examRecord && examRecord.submittedQuestions) || [];
    const isAttempted = Boolean((examRecord && examRecord.isCompleted) || (examRecord && examRecord.inProgress) || submittedQs.length > 0);
    const totalMark = (examRecord && examRecord.totalMark !== undefined) ? examRecord.totalMark : (submittedQs.filter(q => q.isCorrect).length);
    const totalPossible = submittedQs.length || (targetLvl === 'L' ? 20 : (targetLvl === 'U' ? 30 : 40));
    const minPass = Math.ceil(totalPossible * 0.7);
    const isPassed = Boolean(examRecord && examRecord.status === 'Passed') || (totalMark >= minPass && isAttempted);

    const hasOjt = Boolean(ojtRecord && (ojtRecord.totalScore !== undefined || ojtRecord.score !== undefined));
    const ojtScore = hasOjt ? (ojtRecord.totalScore !== undefined ? ojtRecord.totalScore : ojtRecord.score) : 0;
    const ojtMax = (ojtRecord && ojtRecord.maxScore) || 50;
    const ojtQualified = hasOjt && (ojtRecord.qualificationStatus === 'Qualified' || ojtScore >= Math.ceil(ojtMax * 0.7));

    let statusText = 'ASSESSMENT PENDING';
    let statusColor = '64748B'; // Muted
    if (isPassed && ojtQualified) {
      statusText = `QUALIFIED — LEVEL UP TO ${targetLvl}`;
      statusColor = '166534'; // Green
    } else if (isPassed && !hasOjt) {
      statusText = 'THEORY PASSED (OJT PENDING)';
      statusColor = '005B9E'; // Blue
    } else if (!isPassed && isAttempted && ojtQualified) {
      statusText = 'OJT QUALIFIED (THEORY RETEST)';
      statusColor = 'D97706'; // Amber
    } else if (isAttempted && !isPassed) {
      statusText = 'RETEST REQUIRED (MIN. MARKS NOT MET)';
      statusColor = 'B91C1C'; // Red
    }

    const marksDisplay = isAttempted ? `${totalMark} / ${totalPossible} Marks` : 'Pending Exam';
    const marksColor = isPassed ? '166534' : (isAttempted ? 'B91C1C' : '64748B');

    // Logo paragraph XML
    let logoXml = '';
    if (logoRId) {
      // 2800000 EMU width (~2.9 inches), 750000 EMU height (~0.78 inches)
      logoXml = `<w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="80"/></w:pPr>
        <w:r>
          <w:drawing>
            <wp:inline distT="0" distB="0" distL="0" distR="0">
              <wp:extent cx="2800000" cy="750000"/>
              <wp:docPr id="1" name="Yokohama Logo"/>
              <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:nvPicPr>
                      <pic:cNvPr id="0" name="Picture 1"/>
                      <pic:cNvPicPr/>
                    </pic:nvPicPr>
                    <pic:blipFill>
                      <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${logoRId}"/>
                      <a:stretch><a:fillRect/></a:stretch>
                    </pic:blipFill>
                    <pic:spPr>
                      <a:xfrm><a:off x="0" y="0"/><a:ext cx="2800000" cy="750000"/></a:xfrm>
                      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                    </pic:spPr>
                  </pic:pic>
                </a:graphicData>
              </a:graphic>
            </wp:inline>
          </w:drawing>
        </w:r>
      </w:p>`;
    }

    // Metadata Table (Table 0)
    const table0Xml = `<w:tbl>
      <w:tblPr>
        <w:tblW w:w="9600" w:type="dxa"/>
        <w:jc w:val="center"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tr>
        ${buildTableCell('NAME', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(empName, { bold: true, width: 3000, color: '0F172A' })}
        ${buildTableCell('EMPLOYEE NO', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(empNo, { bold: true, width: 3000, color: '005B9E' })}
      </w:tr>
      <w:tr>
        ${buildTableCell('DEPARTMENT', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(dept, { width: 3000, color: '0F172A' })}
        ${buildTableCell('DOJ', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(doj, { width: 3000, color: '0F172A' })}
      </w:tr>
      <w:tr>
        ${buildTableCell('SECTION', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(section, { bold: true, width: 3000, color: '005B9E' })}
        ${buildTableCell('DATE', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(attemptDate, { width: 3000, color: '0F172A' })}
      </w:tr>
      <w:tr>
        ${buildTableCell('TOTAL MARKS', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(marksDisplay, { bold: true, width: 3000, color: marksColor })}
        ${buildTableCell('STATUS / RESULT', { bold: true, bg: 'F1F5F9', width: 1800, color: '002B49' })}
        ${buildTableCell(statusText, { bold: true, width: 3000, color: statusColor })}
      </w:tr>
    </w:tbl>`;

    // Questions XML
    let questionsXml = '';
    if (submittedQs && submittedQs.length > 0) {
      questionsXml += `<w:p><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="002B49"/></w:rPr><w:t>THEORY ASSESSMENT QUESTIONNAIRE &amp; CANDIDATE RESPONSE RECORD</w:t></w:r></w:p>`;

      submittedQs.forEach((q, idx) => {
        const qNum = idx + 1;
        const qText = q.question || `Question ${qNum}`;
        const isCorr = Boolean(q.isCorrect);
        const selKey = (q.selectedKey || '').trim().toUpperCase();
        const corrKey = (q.correctKey || '').trim().toUpperCase();

        const markBadge = isCorr ? '   [Mark: 1/1 — Correct]' : '   [Mark: 0/1 — Incorrect]';
        const markBadgeColor = isCorr ? '166534' : 'B91C1C';

        questionsXml += `<w:p>
          <w:pPr><w:spacing w:before="140" w:after="40"/></w:pPr>
          <w:r>
            <w:rPr><w:b/><w:sz w:val="19"/><w:color w:val="0F172A"/></w:rPr>
            <w:t xml:space="preserve">${qNum}. ${escapeXml(qText)}</w:t>
          </w:r>
          <w:r>
            <w:rPr><w:b/><w:sz w:val="17"/><w:color w:val="${markBadgeColor}"/></w:rPr>
            <w:t xml:space="preserve">${markBadge}</w:t>
          </w:r>
        </w:p>`;

        if (q.options && Array.isArray(q.options)) {
          const keys = ['A', 'B', 'C', 'D'];
          q.options.forEach((opt, optIdx) => {
            const optKey = (opt.key || keys[optIdx] || 'A').toUpperCase();
            const optText = opt.text || opt;
            const isSel = (optKey === selKey);
            const isKey = (optKey === corrKey);

            let prefix = `    ${optKey}. `;
            let optColor = '334155';
            let isBold = false;

            if (isSel) {
              isBold = true;
              if (isCorr) {
                prefix = `    [✔ CANDIDATE SELECTED - CORRECT (+1 Mark)]  ${optKey}. `;
                optColor = '166534';
              } else {
                prefix = `    [✘ CANDIDATE SELECTED - INCORRECT (0 Marks)]  ${optKey}. `;
                optColor = 'B91C1C';
              }
            } else if (isKey && !isCorr) {
              isBold = true;
              prefix = `    [✔ OFFICIAL ANSWER KEY]  ${optKey}. `;
              optColor = '166534';
            }

            questionsXml += `<w:p>
              <w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>
              <w:r>
                <w:rPr>
                  <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
                  ${isBold ? '<w:b/>' : ''}
                  <w:sz w:val="17"/>
                  <w:color w:val="${optColor}"/>
                </w:rPr>
                <w:t xml:space="preserve">${escapeXml(prefix + optText)}</w:t>
              </w:r>
            </w:p>`;
          });
        }
      });
    }

    // OJT Practical Evaluation Section
    const normSec = normalizeSectionKey(section);
    const ojtInfo = OJT_CHECKPOINTS_MAP[normSec] || OJT_CHECKPOINTS_MAP['tire_building'];

    let ojtXml = `<w:p>
      <w:pPr><w:spacing w:before="300" w:after="80"/></w:pPr>
      <w:r>
        <w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="002B49"/></w:rPr>
        <w:t>${escapeXml(ojtInfo.title)}</w:t>
      </w:r>
      <w:r>
        <w:rPr><w:sz w:val="17"/><w:color w:val="64748B"/></w:rPr>
        <w:t xml:space="preserve">  (${escapeXml(ojtInfo.formatNo)})</w:t>
      </w:r>
    </w:p>`;

    if (hasOjt) {
      const ojtScores = (ojtRecord && (ojtRecord.scores || ojtRecord.checkpointScores)) || {};
      let ojtRowsXml = `<w:tr>
        ${buildTableCell('S.No', { bold: true, bg: 'F1F5F9', width: 800, color: '002B49', align: 'center' })}
        ${buildTableCell('Practical Evaluation Checkpoint', { bold: true, bg: 'F1F5F9', width: 6800, color: '002B49' })}
        ${buildTableCell('Marks Awarded', { bold: true, bg: 'F1F5F9', width: 2000, color: '002B49', align: 'center' })}
      </w:tr>`;

      ojtInfo.checkpoints.forEach(([sNo, desc]) => {
        const sc = ojtScores[String(sNo)] !== undefined ? ojtScores[String(sNo)] : (ojtScores[sNo] !== undefined ? ojtScores[sNo] : '-');
        const scStr = sc !== '-' ? `${sc} / 5 Marks` : '- / 5 Marks';
        ojtRowsXml += `<w:tr>
          ${buildTableCell(String(sNo), { bold: true, width: 800, color: '64748B', align: 'center' })}
          ${buildTableCell(desc, { width: 6800, color: '0F172A' })}
          ${buildTableCell(scStr, { bold: true, width: 2000, color: '005B9E', align: 'center' })}
        </w:tr>`;
      });

      ojtXml += `<w:tbl>
        <w:tblPr>
          <w:tblW w:w="9600" w:type="dxa"/>
          <w:jc w:val="center"/>
          <w:tblBorders>
            <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
            <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
          </w:tblBorders>
        </w:tblPr>
        ${ojtRowsXml}
      </w:tbl>`;

      ojtXml += `<w:p>
        <w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr>
        <w:r>
          <w:rPr><w:b/><w:sz w:val="19"/><w:color w:val="${ojtQualified ? '166534' : 'B91C1C'}"/></w:rPr>
          <w:t xml:space="preserve">Practical Score: ${ojtScore} / ${ojtMax} Marks   •   Status: ${ojtRecord.qualificationStatus || (ojtQualified ? 'Qualified' : 'Needs Retest')}</w:t>
        </w:r>
      </w:p>`;

      const comments = ojtRecord.comments || 'Practical evaluation satisfactory.';
      ojtXml += `<w:p>
        <w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>
        <w:r>
          <w:rPr><w:sz w:val="17"/><w:color w:val="334155"/></w:rPr>
          <w:t xml:space="preserve">Improvement Comments: ${escapeXml(comments)}</w:t>
        </w:r>
      </w:p>`;

      const committee = `Safety Rep: ${ojtRecord.safetyRep || '-'}  |  Quality Rep: ${ojtRecord.qualityRep || '-'}  |  CI Rep: ${ojtRecord.ciRep || '-'}`;
      ojtXml += `<w:p>
        <w:pPr><w:spacing w:before="20" w:after="60"/></w:pPr>
        <w:r>
          <w:rPr><w:sz w:val="16"/><w:color w:val="64748B"/></w:rPr>
          <w:t xml:space="preserve">Evaluation Committee: ${escapeXml(committee)}</w:t>
        </w:r>
      </w:p>`;
    } else {
      ojtXml += `<w:p>
        <w:pPr><w:spacing w:before="80" w:after="80"/></w:pPr>
        <w:r>
          <w:rPr><w:i/><w:sz w:val="17"/><w:color w:val="64748B"/></w:rPr>
          <w:t>Practical OJT Status: In-section practical evaluation is pending for this employee. Practical marks will append upon supervisor submission.</w:t>
        </w:r>
      </w:p>`;
    }

    // Sign-Off Block
    const signOffXml = `<w:p><w:pPr><w:spacing w:before="280" w:after="40"/></w:pPr></w:p>
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="9600" w:type="dxa"/>
        <w:jc w:val="center"/>
        <w:tblBorders>
          <w:top w:val="none"/>
          <w:bottom w:val="none"/>
          <w:left w:val="none"/>
          <w:right w:val="none"/>
          <w:insideH w:val="none"/>
          <w:insideV w:val="none"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tr>
        ${buildTableCell('\n\n___________________________', { width: 3200, align: 'center', color: '94A3B8' })}
        ${buildTableCell('\n\n___________________________', { width: 3200, align: 'center', color: '94A3B8' })}
        ${buildTableCell('\n\n___________________________', { width: 3200, align: 'center', color: '94A3B8' })}
      </w:tr>
      <w:tr>
        ${buildTableCell(`Candidate Signature\n${empName} (${empNo})`, { bold: true, width: 3200, align: 'center', sizePt: 8.5, color: '0F172A' })}
        ${buildTableCell('QA Section Evaluator\nTechnical Incharge / Supervisor', { bold: true, width: 3200, align: 'center', sizePt: 8.5, color: '0F172A' })}
        ${buildTableCell('Quality Assurance Manager\nPlant Quality Head Approval &amp; Seal', { bold: true, width: 3200, align: 'center', sizePt: 8.5, color: '0F172A' })}
      </w:tr>
    </w:tbl>`;

    // Footer
    const footerXml = `<w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="200" w:after="0"/></w:pPr>
      <w:r>
        <w:rPr><w:sz w:val="15"/><w:color w:val="94A3B8"/></w:rPr>
        <w:t>YOKOHAMA OFF-HIGHWAY TIRES • OFFICIAL QA ILUO AUDIT RECORD • STRICTLY CONFIDENTIAL</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="0"/></w:pPr>
      <w:r>
        <w:rPr><w:sz w:val="14"/><w:color w:val="94A3B8"/></w:rPr>
        <w:t>Document generated: ${new Date().toLocaleString('en-GB')}</w:t>
      </w:r>
    </w:p>`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${logoXml}
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="40"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="24"/><w:color w:val="002B49"/></w:rPr>
        <w:t>YOKOHAMA OFF-HIGHWAY TIRES (ATC TIRES PVT. LTD.)</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="160"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr>
        <w:t>QUALITY ASSURANCE DIVISION — ILUO SKILL LEVEL QUALIFICATION RECORD</w:t>
      </w:r>
    </w:p>
    ${table0Xml}
    ${questionsXml}
    ${ojtXml}
    ${signOffXml}
    ${footerXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  async function createDocxZip(data, jszipInstance, logoBufferOrBase64) {
    const JSZip = jszipInstance || (typeof window !== 'undefined' ? window.JSZip : null);
    if (!JSZip) throw new Error('JSZip library is required to generate DOCX');

    const zip = new JSZip();

    // 1. [Content_Types].xml
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);

    // 2. _rels/.rels
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    // 3. word/_rels/document.xml.rels
    let logoRId = null;
    if (logoBufferOrBase64) {
      logoRId = 'rId2';
      zip.file('word/media/image1.png', logoBufferOrBase64, { binary: true });
      zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
    } else {
      zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
    }

    // 4. word/styles.xml
    zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
        <w:sz w:val="20"/>
        <w:color w:val="0F172A"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>`);

    // 5. word/document.xml
    data.logoRId = logoRId;
    const documentXml = generateDocumentXml(data);
    zip.file('word/document.xml', documentXml);

    return zip;
  }

  // Export for Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      OJT_CHECKPOINTS_MAP,
      normalizeSectionKey,
      generateDocumentXml,
      createDocxZip
    };
  }

  // Export for browser
  if (typeof window !== 'undefined') {
    window.YokohamaDocxGenerator = {
      OJT_CHECKPOINTS_MAP,
      normalizeSectionKey,
      generateDocumentXml,
      createDocxZip
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
