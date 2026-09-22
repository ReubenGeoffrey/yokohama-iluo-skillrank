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

  function normalize(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function getEnglishPrefix(str) {
    if (!str) return '';
    const parts = str.split(/[\/\?\n\r]/);
    return normalize(parts[0]);
  }

  function createMarkRun(isCorrect) {
    const symbol = isCorrect ? '✔  ' : '✘  ';
    const color = isCorrect ? '166534' : 'B91C1C';
    return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${symbol}</w:t></w:r>`;
  }

  function markInlineOptions(xml, corrKey, selKey) {
    corrKey = (corrKey || 'A').toUpperCase().trim();
    selKey = (selKey || corrKey).toUpperCase().trim();

    let tickCount = 0;
    const replaced = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (fullMatch, openTag, textContent, closeTag) => {
      const optRegex = /(^|[\s\r\n\t])([a-d])([\.\)])(\s*)/gi;
      let hasMatches = false;
      const parts = [];
      let lastIndex = 0;
      let m;

      while ((m = optRegex.exec(textContent)) !== null) {
        hasMatches = true;
        const prefix = m[1];
        const optLetter = m[2].toUpperCase();
        const delimiter = m[3];
        const trailingSpace = m[4];

        const isCorr = (optLetter === corrKey);
        const isSel = (optLetter === selKey);

        let markXml = '';
        if (isCorr) {
          markXml = createMarkRun(true);
          tickCount++;
        } else if (isSel && !isCorr) {
          markXml = createMarkRun(false);
          tickCount++;
        }

        const beforeMatch = textContent.substring(lastIndex, m.index);
        if (markXml) {
          parts.push(beforeMatch + prefix);
          parts.push(`${closeTag}</w:r>${markXml}<w:r>${openTag}${optLetter}${delimiter}${trailingSpace}`);
        } else {
          parts.push(beforeMatch + prefix + optLetter + delimiter + trailingSpace);
        }
        lastIndex = m.index + m[0].length;
      }

      if (hasMatches) {
        parts.push(textContent.substring(lastIndex));
        return openTag + parts.join('') + closeTag;
      }
      return fullMatch;
    });

    return { xml: replaced, tickCount };
  }

  function markParagraphStart(pXml, isCorrect) {
    const markXml = createMarkRun(isCorrect);
    const pPrMatch = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    if (pPrMatch) {
      return pXml.replace(pPrMatch[0], pPrMatch[0] + markXml);
    } else {
      const pOpen = pXml.match(/<w:p(?:\s[^>]*)?>/)[0];
      return pXml.replace(pOpen, pOpen + markXml);
    }
  }

  function findQuestionMatch(text, questionsList) {
    const normText = normalize(text);
    const textEng = getEnglishPrefix(text);
    
    let bestQ = null;
    let bestScore = 0;

    for (const q of questionsList) {
      const qNorm = normalize(q.question);
      const qEng = getEnglishPrefix(q.question);

      if (textEng.length >= 10 && qEng.length >= 10) {
        if (textEng.includes(qEng) || qEng.includes(textEng)) {
          return q;
        }
      }

      const textTokens = new Set(normText.split(' ').filter(w => w.length > 3));
      const qTokens = new Set(qNorm.split(' ').filter(w => w.length > 3));
      if (textTokens.size === 0 || qTokens.size === 0) continue;

      let matchCount = 0;
      for (const t of textTokens) {
        if (qTokens.has(t)) matchCount++;
      }
      const score = matchCount / Math.max(textTokens.size, qTokens.size);
      if (score > bestScore && score >= 0.42) {
        bestScore = score;
        bestQ = q;
      }
    }

    return bestQ;
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
    const targetLvl = (examRecord && examRecord.targetLevel) || emp.targetLevel || emp.currentLevel || 'O';
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
    let cutOffIdx = partAfterTbl.indexOf('Assessment Questionnaire for Internal');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('Parameters – Skill');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('Parameters - Skill');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('Marks Classification for Skill');
    if (cutOffIdx === -1) cutOffIdx = partAfterTbl.indexOf('FTC Associate Observations');

    let questionsPart = cutOffIdx !== -1 ? partAfterTbl.substring(0, cutOffIdx) : partAfterTbl;
    const tailPart = cutOffIdx !== -1 ? partAfterTbl.substring(cutOffIdx) : '';

    // Build list of all known questions:
    // 1. Submitted candidate questions take first precedence (contains user's actual answer & correctness)
    const allKnownQuestions = [];
    const seenNormQuestions = new Set();

    if (submittedQs && submittedQs.length > 0) {
      submittedQs.forEach(q => {
        const normQ = normalize(q.question);
        if (normQ && !seenNormQuestions.has(normQ)) {
          seenNormQuestions.add(normQ);
          allKnownQuestions.push({
            question: q.question,
            options: q.options,
            correctKey: (q.correctKey || q.correctAnswer || 'A').toUpperCase().trim(),
            selectedKey: (q.selectedKey || q.userAnswer || q.correctKey || q.correctAnswer || 'A').toUpperCase().trim(),
            isCorrect: Boolean(q.isCorrect || (q.selectedKey && q.selectedKey === q.correctKey))
          });
        }
      });
    }

    // 2. Add question bank questions as fallback (ensures every template question is marked even if not in candidate exam)
    if (questionBankList && Array.isArray(questionBankList)) {
      questionBankList.forEach(q => {
        const normQ = normalize(q.question);
        if (normQ && !seenNormQuestions.has(normQ)) {
          seenNormQuestions.add(normQ);
          allKnownQuestions.push({
            question: q.question,
            options: q.options,
            correctKey: (q.correctAnswer || q.correctKey || 'A').toUpperCase().trim(),
            selectedKey: (q.correctAnswer || q.correctKey || 'A').toUpperCase().trim(),
            isCorrect: true
          });
        }
      });
    }

    let activeQ = null;
    let activeOptIndex = 0;

    const pRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    questionsPart = questionsPart.replace(pRegex, (pXml) => {
      const text = pXml.replace(/<w:br\s*\/?>/gi, '\n').replace(/<w:tab\s*\/?>/gi, '\t').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim();
      if (!text || text.includes('MERGEFIELD') || text.toUpperCase().includes('TOTAL MARKS') || text.toUpperCase().includes('MARK %')) {
        return pXml;
      }

      const upperText = text.toUpperCase();
      const isKnownHeader = [
        'SAFETY', 'CI & TPM', 'TPM', 'PROCESS', 'QUALITY', 'PARAMETERS', 
        'MARKS CLASSIFICATION', 'QA & PROCESS', 'S.NO', 'QUESTION DESCRIPTION',
        'ASSESSMENT QUESTIONNAIRE', 'DEPARTMENT', 'DOJ', 'SECTION', 'DATE', 'NAME', 'EMPLOYEE NO'
      ].some(h => upperText === h || upperText.startsWith(h + ' –') || upperText.startsWith(h + ' -') || upperText.startsWith('ASSESSMENT QUESTIONNAIRE FOR'));

      const hasOptions = /(?:^|[\s\r\n\t])([a-d])[\.\)]/i.test(text);
      const isQuestionLike = text.includes('?') || hasOptions;

      if (isKnownHeader && !hasOptions) {
        activeQ = null;
        return pXml;
      }

      if (!isQuestionLike && !activeQ) {
        return pXml;
      }

      // Check if this paragraph is a question
      const matchedQ = findQuestionMatch(text, allKnownQuestions);
      if (matchedQ) {
        activeQ = matchedQ;
        activeOptIndex = 0;

        // If options are inline in this question paragraph
        if (hasOptions) {
          const res = markInlineOptions(pXml, activeQ.correctKey || 'A', activeQ.selectedKey || activeQ.correctKey || 'A');
          activeQ = null;
          return res.xml;
        }
        return pXml;
      }

      // If active question is waiting for options
      if (activeQ) {
        // Standalone option paragraph with inline options
        if (hasOptions) {
          const res = markInlineOptions(pXml, activeQ.correctKey || 'A', activeQ.selectedKey || activeQ.correctKey || 'A');
          activeQ = null;
          return res.xml;
        }

        // Standalone option paragraph without letter prefix (e.g. Tire Curing)
        if (activeOptIndex < 4) {
          const optKey = ['A', 'B', 'C', 'D'][activeOptIndex];
          activeOptIndex++;
          const corrKey = (activeQ.correctKey || 'A').toUpperCase().trim();
          const selKey = (activeQ.selectedKey || corrKey).toUpperCase().trim();
          const isCorr = (optKey === corrKey);
          const isSel = (optKey === selKey);

          let modifiedXml = pXml;
          if (isCorr) {
            modifiedXml = markParagraphStart(pXml, true);
          } else if (isSel && !isCorr) {
            modifiedXml = markParagraphStart(pXml, false);
          }

          if (activeOptIndex >= 4) {
            activeQ = null;
          }
          return modifiedXml;
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
