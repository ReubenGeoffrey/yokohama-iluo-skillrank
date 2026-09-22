// =====================================================================
// YOKOHAMA ILUO OFFICIAL DOCX REPORT GENERATOR (Exact Template Mapper)
// Preserves exact D:\QC question templates with perfect answer tick mapping
// =====================================================================

(function (global) {
  'use strict';

  const TEMPLATE_FILE_MAP = {
    'l_final finish qa': 'L Level - Final Finish QA.docx',
    'l_final finish rro & alt qa': 'L Level - Final Finish RRO & ALT QA.docx',
    'l_tire building qa': 'L Level - Tire Building QA.docx',
    'l_tire curing qa': 'L Level - Tire Curing QA.docx',
    'l_solid tire qa': 'L Level - Solid Tire QA.docx',
    'l_preparatory qa': 'L Level - Preparatory QA.docx',
    'l_warehouse qa': 'L Level - Warehouse QA.docx',
    'l_fid inspector qa': 'L Level - FID Inspector QA.docx',

    'u_final finish qa': 'U Level - Final Finish QA.docx',
    'u_final finish rro & alt qa': 'U Level - Final Finish RRo & ALT QA.docx',
    'u_tire building qa': 'U Level - Tire Building QA.docx',
    'u_tire curing qa': 'U Level - Tire Curing QA.docx',
    'u_solid tire qa': 'U Level - Solid Tire QA.docx',
    'u_preparatory qa': 'U Level - Preparatory QA.docx',
    'u_warehouse qa': 'U Level - Warehouse QA.docx',
    'u_fid inspector qa': 'U Level - FID Inspector QA.docx',

    'o_final finish qa': 'O Level - Final Finish QA.docx',
    'o_final finish rro & alt qa': 'O Level - Final Finish RRO & ALT QA.docx',
    'o_tire building qa': 'O Level - Tire Building QA.docx',
    'o_tire curing qa': 'O Level - Tire Curing QA.docx',
    'o_solid tire qa': 'O Level - Solid Tire QA.docx',
    'o_preparatory qa': 'O Level - Preparatory QA.docx',
    'o_warehouse qa': 'O Level - Warehouse QA.docx',
    'o_fid inspector qa': 'O Level - FID Inspector QA.docx'
  };

  function getTemplateFilename(level, section) {
    const lvl = (level || 'O').toLowerCase().trim();
    let sec = (section || 'tire building qa').toLowerCase().trim().replace(/\s+/g, ' ').replace('ware house', 'warehouse');
    if (sec.includes('rro') || sec.includes('alt')) sec = 'final finish rro & alt qa';
    else if (sec.includes('preparatory')) sec = 'preparatory qa';
    else if (sec.includes('solid')) sec = 'solid tire qa';
    else if (sec.includes('building') || sec.includes('tbm')) sec = 'tire building qa';
    else if (sec.includes('curing')) sec = 'tire curing qa';
    else if (sec.includes('warehouse') || sec.includes('data entry')) sec = 'warehouse qa';
    else if (sec.includes('fid')) sec = 'fid inspector qa';
    else if (sec.includes('finish')) sec = 'final finish qa';

    const key = `${lvl}_${sec}`;
    return TEMPLATE_FILE_MAP[key] || `${(level || 'O').toUpperCase()} Level - Tire Building QA.docx`;
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

  async function mapExactTemplate(templateBuf, emp, examRecord, jszipInstance, questionBankList) {
    const JSZip = jszipInstance || (typeof window !== 'undefined' ? window.JSZip : null);
    if (!JSZip) throw new Error('JSZip library is required to map DOCX template');

    const zip = await JSZip.loadAsync(templateBuf);
    let docXml = await zip.file('word/document.xml').async('text');

    const empName = emp.name || `Employee ${emp.empNo}`;
    const empNo = emp.empNo || '900000';
    const dept = emp.dept || 'QUALITY CONTROL';
    const section = emp.section || 'Tire building QA';
    const doj = emp.doj || '-';
    const targetLvl = (examRecord && examRecord.targetLevel) || emp.targetLevel || 'O';
    const attemptDate = (examRecord && examRecord.attemptDate) || new Date().toLocaleDateString('en-GB');

    const submittedQs = (examRecord && examRecord.submittedQuestions) || [];
    const isAttempted = Boolean((examRecord && examRecord.isCompleted) || (examRecord && examRecord.inProgress) || submittedQs.length > 0);
    const totalMark = (examRecord && examRecord.totalMark !== undefined) ? examRecord.totalMark : (submittedQs.filter(q => q.isCorrect).length);
    const totalPossible = submittedQs.length || (targetLvl === 'L' ? 20 : (targetLvl === 'U' ? 30 : 40));
    const minPass = Math.ceil(totalPossible * 0.7);
    const isPassed = Boolean(examRecord && examRecord.status === 'Passed') || (totalMark >= minPass && isAttempted);

    const marksDisplay = isAttempted ? `${totalMark} / ${totalPossible} Marks` : 'Pending Exam';
    const resultDisplay = isPassed ? 'QUALIFIED' : (isAttempted ? 'RETEST REQUIRED' : 'PENDING');

    // 1. Update Table 0 (Metadata Table)
    const tblMatch = docXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/);
    let tblEndIndex = 0;
    if (tblMatch) {
      tblEndIndex = docXml.indexOf(tblMatch[0]) + tblMatch[0].length;
      let tblXml = tblMatch[0];
      const trRegex = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
      let trMatch;
      const rows = [];
      while ((trMatch = trRegex.exec(tblXml)) !== null) {
        rows.push(trMatch[0]);
      }

      function updateCellInRow(rowXml, targetColIndex, valueText, isBold = true, color = '0F172A') {
        const tcRegex = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
        let m;
        let colIdx = 0;
        let newRow = '';
        let lastEnd = 0;

        while ((m = tcRegex.exec(rowXml)) !== null) {
          if (colIdx === targetColIndex) {
            const oldCell = m[0];
            const tcPrMatch = oldCell.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/);
            const tcPr = tcPrMatch ? tcPrMatch[0] : '';
            const tcOpenTag = oldCell.match(/<w:tc(?:\s[^>]*)?>/)[0];

            const newCell = `${tcOpenTag}${tcPr}<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial Body" w:hAnsi="Arial Body"/><w:sz w:val="20"/><w:szCs w:val="20"/>${isBold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${escapeXml(valueText)}</w:t></w:r></w:p></w:tc>`;

            newRow += rowXml.substring(lastEnd, m.index) + newCell;
            lastEnd = m.index + oldCell.length;
          }
          colIdx++;
        }
        newRow += rowXml.substring(lastEnd);
        return newRow;
      }

      if (rows.length >= 4) {
        rows[0] = updateCellInRow(rows[0], 1, empName, true, '0F172A');
        rows[0] = updateCellInRow(rows[0], 3, empNo, true, '005B9E');

        rows[1] = updateCellInRow(rows[1], 1, dept, false, '0F172A');
        rows[1] = updateCellInRow(rows[1], 3, doj, false, '0F172A');

        rows[2] = updateCellInRow(rows[2], 1, section, true, '005B9E');
        rows[2] = updateCellInRow(rows[2], 3, attemptDate, false, '0F172A');

        rows[3] = updateCellInRow(rows[3], 1, marksDisplay, true, isPassed ? '166534' : 'B91C1C');
        rows[3] = updateCellInRow(rows[3], 3, resultDisplay, true, isPassed ? '166534' : 'B91C1C');

        const tblPrMatch = tblXml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/);
        const tblPr = tblPrMatch ? tblPrMatch[0] : '';
        const tblGridMatch = tblXml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/);
        const tblGrid = tblGridMatch ? tblGridMatch[0] : '';

        const newTblXml = `<w:tbl>${tblPr}${tblGrid}${rows.join('')}</w:tbl>`;
        docXml = docXml.replace(tblMatch[0], newTblXml);
        tblEndIndex = docXml.indexOf(newTblXml) + newTblXml.length;
      }
    }

    // 2. Map Answers with Tick Mark in Paragraphs (AFTER Table 0 only)
    const partBeforeTbl = docXml.substring(0, tblEndIndex);
    let partAfterTbl = docXml.substring(tblEndIndex);

    // Stop mapping tick marks if supervisor parameters table is reached
    let cutOffIdx = partAfterTbl.indexOf('Parameters – Skill');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('Parameters - Skill');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('Marks Classification for Skill');

    let questionsPart = cutOffIdx !== -1 ? partAfterTbl.substring(0, cutOffIdx) : partAfterTbl;
    const tailPart = cutOffIdx !== -1 ? partAfterTbl.substring(cutOffIdx) : '';

    // Build lookup of questions by normalized text
    const qLookup = new Map();
    if (submittedQs && submittedQs.length > 0) {
      submittedQs.forEach(q => {
        const cleanQ = (q.question || '').replace(/[\s\.\?\/,:;\(\)]+/g, '').toLowerCase().substring(0, 25);
        if (cleanQ) qLookup.set(cleanQ, q);
      });
    }

    // Also populate question bank answer keys if provided
    if (questionBankList && Array.isArray(questionBankList)) {
      const secNorm = section.toLowerCase();
      const relevantQs = questionBankList.filter(q => (q.section || '').toLowerCase().includes(secNorm) || secNorm.includes((q.section || '').toLowerCase()));
      relevantQs.forEach(q => {
        const cleanQ = (q.question || '').replace(/[\s\.\?\/,:;\(\)]+/g, '').toLowerCase().substring(0, 25);
        if (cleanQ && !qLookup.has(cleanQ)) {
          qLookup.set(cleanQ, {
            question: q.question,
            options: q.options,
            correctKey: q.correctAnswer || 'A',
            selectedKey: q.correctAnswer || 'A',
            isCorrect: true
          });
        }
      });
    }

    let currentActiveQ = null;
    let optionIndex = 0;

    const pRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    questionsPart = questionsPart.replace(pRegex, (pXml) => {
      const text = pXml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return pXml;

      const textClean = text.replace(/[\s\.\?\/,:;\(\)]+/g, '').toLowerCase();

      // Check if this paragraph is a question
      for (const [cleanQKey, qData] of qLookup.entries()) {
        if (textClean.includes(cleanQKey) || cleanQKey.includes(textClean.substring(0, 25))) {
          currentActiveQ = qData;
          optionIndex = 0;
          return pXml;
        }
      }

      // If active question, check if this is an option (up to 4 options)
      if (currentActiveQ && optionIndex < 4) {
        const isHeader = ['SAFETY', 'CI & TPM', 'TPM', 'PROCESS', 'QUALITY', 'PARAMETERS', 'MARKS CLASSIFICATION'].includes(text.toUpperCase());
        const isNextQ = text.includes('?') || /^\d+[\.\)]\s+[A-Za-z]/.test(text);

        if (!isHeader && !isNextQ) {
          const keyChars = ['A', 'B', 'C', 'D'];
          const optKey = keyChars[optionIndex];
          optionIndex++;

          const selKey = (currentActiveQ.selectedKey || '').trim().toUpperCase();
          const corrKey = (currentActiveQ.correctKey || '').trim().toUpperCase();
          const isSel = (optKey === selKey);
          const isCorr = (optKey === corrKey);

          let tickXml = '';
          if (isCorr) {
            // Perfect answer -> TICK MARK ✔ (bold green)
            tickXml = `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="24"/><w:color w:val="166534"/></w:rPr><w:t xml:space="preserve">✔  </w:t></w:r>`;
          } else if (isSel && !isCorr) {
            // Candidate selected wrong answer -> ✘ (bold red)
            tickXml = `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="24"/><w:color w:val="B91C1C"/></w:rPr><w:t xml:space="preserve">✘  </w:t></w:r>`;
          }

          if (tickXml) {
            const pPrMatch = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
            if (pPrMatch) {
              return pXml.replace(pPrMatch[0], pPrMatch[0] + tickXml);
            } else {
              const pOpen = pXml.match(/<w:p(?:\s[^>]*)?>/)[0];
              return pXml.replace(pOpen, pOpen + tickXml);
            }
          }
        } else {
          currentActiveQ = null;
        }
      }

      return pXml;
    });

    const finalDocXml = partBeforeTbl + questionsPart + tailPart;
    zip.file('word/document.xml', finalDocXml);
    return zip;
  }

  // Export for Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TEMPLATE_FILE_MAP,
      getTemplateFilename,
      mapExactTemplate
    };
  }

  // Export for browser
  if (typeof window !== 'undefined') {
    window.YokohamaDocxGenerator = {
      TEMPLATE_FILE_MAP,
      getTemplateFilename,
      mapExactTemplate
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
