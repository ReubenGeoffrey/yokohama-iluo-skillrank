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

    // Check if OJT evaluation data exists to append to the comprehensive report
    let ojtSectionXml = '';
    const ojtRec = optionalOjtData || (typeof getStoredOjtRecords === 'function' ? getStoredOjtRecords()[empNo] : null) || (global.globalOjtEvaluations ? global.globalOjtEvaluations.get(String(empNo)) : null);
    let ojtTmpl = optionalOjtTemplate;
    if (!ojtTmpl && typeof global.OJT_OFFICIAL_TEMPLATES !== 'undefined') {
      ojtTmpl = typeof getOjtTemplateForSection === 'function' ? getOjtTemplateForSection(section) : global.OJT_OFFICIAL_TEMPLATES['87D'];
    }
    if (ojtRec && ojtTmpl) {
      ojtSectionXml = buildOjtDocxBodyXml(emp, ojtTmpl, ojtRec.scores || {}, ojtRec.wiChecks || {}, ojtRec, false);
    }

    let finalDocXml = partBeforeTbl + questionsPart + tailPart;
    if (ojtSectionXml) {
      const sectPrMatch = finalDocXml.match(/<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>\s*<\/w:body>/);
      if (sectPrMatch) {
        finalDocXml = finalDocXml.replace(sectPrMatch[0], `${ojtSectionXml}${sectPrMatch[0]}`);
      } else {
        finalDocXml = finalDocXml.replace('</w:body>', `${ojtSectionXml}</w:body>`);
      }
    }
    zip.file('word/document.xml', finalDocXml);
    return zip;
  }

  function buildOjtDocxBodyXml(emp, tmpl, scores, wiChecks, ojtData, isStandalone = true) {
    scores = scores || {};
    wiChecks = wiChecks || {};
    ojtData = ojtData || {};

    const numCheckpoints = tmpl.checkpointCount || (tmpl.checkpoints ? tmpl.checkpoints.length : 10);
    const maxScore = numCheckpoints * 5;
    let totalScore = 0;
    (tmpl.checkpoints || []).forEach(cp => {
      totalScore += (scores[cp.sno] || 0);
    });
    const pct = Math.round((totalScore / maxScore) * 100);
    const isQual = (ojtData.qualificationStatus === 'Qualified') || (pct >= 70);

    const targetMap = { 'I': 'L', 'L': 'U', 'U': 'O', 'O': 'O' };
    const currLvl = emp.currentLevel || 'I';
    const targetLvl = targetMap[currLvl] || 'L';
    const assessDate = emp.assessmentDate || ojtData.evaluatedAt || new Date().toLocaleDateString('en-GB');

    const tblBorders = `
      <w:tblBorders>
        <w:top w:val="single" w:sz="8" w:space="0" w:color="005B9E"/>
        <w:left w:val="single" w:sz="8" w:space="0" w:color="005B9E"/>
        <w:bottom w:val="single" w:sz="8" w:space="0" w:color="005B9E"/>
        <w:right w:val="single" w:sz="8" w:space="0" w:color="005B9E"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      </w:tblBorders>`;

    function cellXml(text, widthDxa, bold = false, align = 'left', bgColor = null, color = '0F172A', fontSize = 18) {
      const shd = bgColor ? `<w:shd w:val="clear" w:color="auto" w:fill="${bgColor}"/>` : '';
      return `
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="${widthDxa}" w:type="dxa"/>
            ${shd}
            <w:tcMar>
              <w:top w:w="120" w:type="dxa"/>
              <w:bottom w:w="120" w:type="dxa"/>
              <w:left w:w="160" w:type="dxa"/>
              <w:right w:w="160" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
          <w:p>
            <w:pPr><w:jc w:val="${align}"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
            <w:r>
              <w:rPr>
                <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
                ${bold ? '<w:b/><w:bCs/>' : ''}
                <w:sz w:val="${fontSize}"/>
                <w:szCs w:val="${fontSize}"/>
                <w:color w:val="${color}"/>
              </w:rPr>
              <w:t xml:space="preserve">${escapeXml(text)}</w:t>
            </w:r>
          </w:p>
        </w:tc>`;
    }

    const empTable = `
      <w:tbl>
        <w:tblPr>
          <w:tblW w:w="9360" w:type="dxa"/>
          <w:jc w:val="center"/>
          ${tblBorders}
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="4680"/>
          <w:gridCol w:w="2340"/>
          <w:gridCol w:w="2340"/>
        </w:tblGrid>
        <w:tr>
          ${cellXml('Name: ' + (emp.name || ''), 4680, true)}
          ${cellXml('Emp ID: ' + (emp.empNo || ''), 2340, true, 'center', null, '005B9E')}
          ${cellXml('Joining Date: ' + (emp.doj || '-'), 2340, false, 'center')}
        </w:tr>
        <w:tr>
          ${cellXml('Section & Dept.: ' + (emp.section || '-') + ' / ' + (emp.dept || 'QUALITY CONTROL'), 4680, false)}
          ${cellXml(`Skill Level: ( ${currLvl} ) TO ( ${targetLvl} )`, 2340, true, 'center', null, '0284C7')}
          ${cellXml('Assessment Date: ' + assessDate, 2340, false, 'center')}
        </w:tr>
      </w:tbl>`;

    const cpRows = (tmpl.checkpoints || []).map((cp, idx) => {
      const sc = scores[cp.sno];
      const scText = (sc !== undefined && sc > 0) ? `${sc} / 5 Marks` : '- / 5 Marks';
      const isWi = !!wiChecks[cp.sno];
      const wiText = isWi ? '✓ OK' : '-';
      const rowBg = idx % 2 === 0 ? 'FFFFFF' : 'F8FAFC';
      const scColor = (sc && sc >= 3) ? '166534' : ((sc && sc > 0) ? 'DC2626' : '64748B');
      return `
        <w:tr>
          ${cellXml(String(cp.sno), 600, true, 'center', rowBg, '475569')}
          ${cellXml(cp.text, 6160, false, 'left', rowBg, '1E293B')}
          ${cellXml(scText, 1600, true, 'center', rowBg, scColor)}
          ${cellXml(wiText, 1000, isWi, 'center', rowBg, isWi ? '166534' : '64748B')}
        </w:tr>`;
    }).join('');

    const checkpointsTable = `
      <w:tbl>
        <w:tblPr>
          <w:tblW w:w="9360" w:type="dxa"/>
          <w:jc w:val="center"/>
          ${tblBorders}
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="600"/>
          <w:gridCol w:w="6160"/>
          <w:gridCol w:w="1600"/>
          <w:gridCol w:w="1000"/>
        </w:tblGrid>
        <w:tr>
          ${cellXml('S.No', 600, true, 'center', '005B9E', 'FFFFFF', 19)}
          ${cellXml('Training Content / Check Point', 6160, true, 'left', '005B9E', 'FFFFFF', 19)}
          ${cellXml('Score', 1600, true, 'center', '005B9E', 'FFFFFF', 19)}
          ${cellXml('WI Check', 1000, true, 'center', '005B9E', 'FFFFFF', 19)}
        </w:tr>
        ${cpRows}
        <w:tr>
          ${cellXml('TOTAL SCORE', 6760, true, 'right', 'F1F5F9', '0F172A', 20)}
          ${cellXml(`${totalScore} / ${maxScore} = ${pct}%`, 1600, true, 'center', isQual ? 'DCFCE7' : 'FEE2E2', isQual ? '166534' : '991B1B', 20)}
          ${cellXml(isQual ? 'QUALIFIED' : 'NEEDS REFOCUS', 1000, true, 'center', isQual ? 'DCFCE7' : 'FEE2E2', isQual ? '166534' : '991B1B', 18)}
        </w:tr>
      </w:tbl>`;

    const evalTable = `
      <w:tbl>
        <w:tblPr>
          <w:tblW w:w="9360" w:type="dxa"/>
          <w:jc w:val="center"/>
          ${tblBorders}
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="1872"/>
          <w:gridCol w:w="1872"/>
          <w:gridCol w:w="1872"/>
          <w:gridCol w:w="1872"/>
          <w:gridCol w:w="1872"/>
        </w:tblGrid>
        <w:tr>
          ${cellXml('Safety (Section Rep)', 1872, true, 'center', 'F1F5F9', '005B9E')}
          ${cellXml('Quality (Section Rep)', 1872, true, 'center', 'F1F5F9', '005B9E')}
          ${cellXml('CI (Representative)', 1872, true, 'center', 'F1F5F9', '005B9E')}
          ${cellXml('Technical (Representative)', 1872, true, 'center', 'F1F5F9', '005B9E')}
          ${cellXml('HR (Representative)', 1872, true, 'center', 'F1F5F9', '005B9E')}
        </w:tr>
        <w:tr>
          ${cellXml((ojtData.safetyRep || '-') + (ojtData.safetyDate ? `\n(${ojtData.safetyDate})` : ''), 1872, false, 'center')}
          ${cellXml((ojtData.qualityRep || '-') + (ojtData.qualityDate ? `\n(${ojtData.qualityDate})` : ''), 1872, false, 'center')}
          ${cellXml((ojtData.ciRep || '-') + (ojtData.ciDate ? `\n(${ojtData.ciDate})` : ''), 1872, false, 'center')}
          ${cellXml((ojtData.techRep || '-') + (ojtData.techDate ? `\n(${ojtData.techDate})` : ''), 1872, false, 'center')}
          ${cellXml((ojtData.hrRep || '-') + (ojtData.hrDate ? `\n(${ojtData.hrDate})` : ''), 1872, false, 'center')}
        </w:tr>
      </w:tbl>`;

    const headTable = `
      <w:tbl>
        <w:tblPr>
          <w:tblW w:w="9360" w:type="dxa"/>
          <w:jc w:val="center"/>
          ${tblBorders}
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="3120"/>
          <w:gridCol w:w="3120"/>
          <w:gridCol w:w="3120"/>
        </w:tblGrid>
        <w:tr>
          ${cellXml('Safety Section Head', 3120, true, 'center', 'F1F5F9', '334155')}
          ${cellXml('Quality Section Head', 3120, true, 'center', 'F1F5F9', '334155')}
          ${cellXml('CI Head', 3120, true, 'center', 'F1F5F9', '334155')}
        </w:tr>
        <w:tr>
          ${cellXml(ojtData.safetyHeadSign || 'Sign & Name with Date', 3120, false, 'center')}
          ${cellXml(ojtData.qualityHeadSign || 'Sign & Name with Date', 3120, false, 'center')}
          ${cellXml(ojtData.ciHeadSign || 'Sign & Name with Date', 3120, false, 'center')}
        </w:tr>
      </w:tbl>`;

    const pageBreak = isStandalone ? '' : '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

    return `
      ${pageBreak}
      <w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="28"/><w:color w:val="0F172A"/></w:rPr><w:t>ATC TIRES PRIVATE LIMITED</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="24"/><w:color w:val="005B9E"/></w:rPr><w:t>${escapeXml(tmpl.title)}</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="160"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t>${escapeXml(tmpl.formatNo)}</w:t></w:r>
      </w:p>

      ${empTable}

      <w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="0F172A"/></w:rPr><w:t>RANK SCALE:   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="DC2626"/></w:rPr><w:t>1 = POOR   |   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="EA580C"/></w:rPr><w:t>2 = FAIR   |   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="D97706"/></w:rPr><w:t>3 = GOOD   |   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="2563EB"/></w:rPr><w:t>4 = VERY GOOD   |   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="17"/><w:color w:val="16A34A"/></w:rPr><w:t>5 = EXCELLENT</w:t></w:r>
      </w:p>

      ${checkpointsTable}

      <w:p>
        <w:pPr><w:spacing w:before="160" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="0F172A"/></w:rPr><w:t>IMPROVEMENT / TRAINING REQUIREMENT:</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:spacing w:before="0" w:after="160"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="18"/><w:color w:val="334155"/></w:rPr><w:t>${escapeXml(ojtData.comments || 'No specific improvement requirements observed. Standard procedures maintained.')}</w:t></w:r>
      </w:p>

      <w:p>
        <w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="005B9E"/></w:rPr><w:t>EVALUATION BY (NAME &amp; SIGN WITH DATE):</w:t></w:r>
      </w:p>
      ${evalTable}

      <w:p>
        <w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="334155"/></w:rPr><w:t>FINAL COMMENT BY SECTION HEADS:</w:t></w:r>
      </w:p>
      ${headTable}

      <w:p>
        <w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="0F172A"/></w:rPr><w:t>FINAL RECOMMENDATION &amp; APPROVAL:   </w:t></w:r>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="${isQual ? '166534' : 'DC2626'}"/></w:rPr><w:t>${isQual ? '[✔] QUALIFIED' : '[✔] NOT QUALIFIED (RETEST REQUIRED)'}</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:spacing w:before="40" w:after="80"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>QUALITY - HEAD SIGN-OFF:   Approved &amp; Documented</w:t></w:r>
      </w:p>
    `;
  }

  async function generateStandaloneOjtDocx(emp, tmpl, scores, wiChecks, ojtData, jszipInstance) {
    const JSZip = jszipInstance || (typeof window !== 'undefined' ? window.JSZip : null);
    if (!JSZip) throw new Error('JSZip library is required to generate OJT Word document');

    const zip = new JSZip();

    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    const bodyContent = buildOjtDocxBodyXml(emp, tmpl, scores, wiChecks, ojtData, true);
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyContent}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    zip.file('word/document.xml', docXml);
    return zip;
  }

  // Export for Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TEMPLATE_FILE_MAP,
      getTemplateFilename,
      mapExactTemplate,
      buildOjtDocxBodyXml,
      generateStandaloneOjtDocx
    };
  }

  // Export for browser
  if (typeof window !== 'undefined') {
    window.YokohamaDocxGenerator = {
      TEMPLATE_FILE_MAP,
      getTemplateFilename,
      mapExactTemplate,
      buildOjtDocxBodyXml,
      generateStandaloneOjtDocx
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
