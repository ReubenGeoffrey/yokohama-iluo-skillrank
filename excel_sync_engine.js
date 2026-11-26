'use strict';

/**
 * ILUO Master Excel Sync & Exact Template-Cloning Export Engine
 * -------------------------------------------------------------
 * Handles:
 *  1. Parsing & auto-detecting Production (6-sheet) and QA (5-sheet) Excel workbooks.
 *  2. Upsert preview & commit into the portal's authoritative Employees, Assessment Records,
 *     and OJT/Gemba Evaluation stores using normalized EMP NO (trimmed, uppercase) as primary key.
 *  3. Exact template-preserving ExcelJS export that loads /public/templates/production_template.xlsx
 *     or /public/templates/qa_template.xlsx, leaves every summary sheet, merged header, chart,
 *     color, border, and column width untouched, writes raw values ONLY into input columns,
 *     preserves dynamic live Excel formulas in all calculated columns, clears leftover rows,
 *     and sets workbook.calcProperties.fullCalcOnLoad = true.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const TEMPLATES_DIR = path.join(__dirname, 'public', 'templates');
const PRODUCTION_TEMPLATE_PATH = path.join(TEMPLATES_DIR, 'production_template.xlsx');
const QA_TEMPLATE_PATH = path.join(TEMPLATES_DIR, 'qa_template.xlsx');

const VALID_LEVELS = new Set(['I', 'L', 'U', 'O']);

// ---------------------------------------------------------------------------
// 1. Normalization & Pure Calculation Utilities
// ---------------------------------------------------------------------------

/**
 * Primary key normalizer for EMP NO (trimmed, uppercase string).
 * @param {unknown} val
 * @returns {string}
 */
function normalizeEmpNo(val) {
  if (val === null || val === undefined) return '';
  const unwrapped = unwrapCellValue(val);
  if (unwrapped === null || unwrapped === undefined) return '';
  return String(unwrapped).trim().toUpperCase();
}

/**
 * Unwraps ExcelJS formula / richText / hyperlink cell objects to their primitive value.
 * @param {unknown} val
 * @returns {unknown}
 */
function unwrapCellValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'object') {
    if (Object.prototype.hasOwnProperty.call(val, 'result')) {
      const r = val.result;
      if (r && typeof r === 'object' && r.error) return null;
      return r !== undefined ? r : null;
    }
    if (Array.isArray(val.richText)) {
      return val.richText.map(part => part.text || '').join('');
    }
    if (typeof val.text === 'string') return val.text;
    if (val.error) return null;
  }
  return val;
}

/**
 * Safely parses numeric marks:
 * - "NIL", "", "-", "NA", "N/A", null, undefined => null (NOT 0!)
 * - Explicit 0 or "0" => 0
 * - Valid finite number => number
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseExcelNumberOrNull(raw) {
  const val = unwrapCellValue(raw);
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  const str = String(val).trim();
  if (!str) return null;
  const upper = str.toUpperCase();
  if (upper === 'NIL' || upper === '-' || upper === 'NA' || upper === 'N/A' || upper === 'ABSENT' || upper === 'AB') {
    return null;
  }
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * Detects whether a raw cell explicitly contains "NIL".
 * @param {unknown} raw
 * @returns {boolean}
 */
function isNilMarker(raw) {
  const val = unwrapCellValue(raw);
  return typeof val === 'string' && val.trim().toUpperCase() === 'NIL';
}

/**
 * Normalizes a skill level code to 'I' | 'L' | 'U' | 'O' | null.
 * @param {unknown} raw
 * @returns {'I'|'L'|'U'|'O'|null}
 */
function normalizeLevel(raw) {
  const val = unwrapCellValue(raw);
  if (val === null || val === undefined) return null;
  const s = String(val).trim().toUpperCase();
  return VALID_LEVELS.has(s) ? /** @type {'I'|'L'|'U'|'O'} */ (s) : null;
}

/**
 * Converts an Excel cell date (Date, serial number, YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY) to YYYY-MM-DD.
 * @param {unknown} raw
 * @returns {string}
 */
function formatExcelDate(raw) {
  const val = unwrapCellValue(raw);
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 1000) {
    // Excel serial date (epoch 1899-12-30 UTC)
    const utcMs = Math.round((val - 25569) * 86400 * 1000);
    const dt = new Date(utcMs);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const dmy = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    let yyyy = dmy[3];
    if (yyyy.length === 2) yyyy = Number(yyyy) > 50 ? '19' + yyyy : '20' + yyyy;
    return `${yyyy}-${mm}-${dd}`;
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return str;
}

/**
 * Converts a YYYY-MM-DD string into a UTC midnight Date object for Excel date cells.
 * @param {string|Date|null|undefined} dateVal
 * @returns {Date|null}
 */
function toExcelDateObject(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date && !Number.isNaN(dateVal.getTime())) return dateVal;
  const iso = formatExcelDate(dateVal);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Returns Production Knowledge max marks by eligible skill level:
 * I=20, L=20, U=30, O=40.
 * @param {string|null} level
 * @returns {number}
 */
function getKnowledgeMaxMarks(level) {
  const lvl = normalizeLevel(level);
  if (lvl === 'O') return 40;
  if (lvl === 'U') return 30;
  return 20;
}

/**
 * Evaluates pass/fail using the Production workbook's exact threshold rules:
 * L >= 50%, U >= 60%, O >= 75% (I >= 50% if applicable, else Fail).
 * @param {string|null} eligibleLevel
 * @param {number|null} pctRatio (0.0 .. 1.0)
 * @returns {'Pass'|'Fail'}
 */
function evaluateTemplatePassFail(eligibleLevel, pctRatio) {
  if (pctRatio === null || pctRatio === undefined || !Number.isFinite(pctRatio)) return 'Fail';
  const lvl = normalizeLevel(eligibleLevel);
  if (lvl === 'L' && pctRatio >= 0.50) return 'Pass';
  if (lvl === 'U' && pctRatio >= 0.60) return 'Pass';
  if (lvl === 'O' && pctRatio >= 0.75) return 'Pass';
  return 'Fail';
}

/**
 * One level down from Eligible skill level when Overall Result is Fail:
 * O -> U, U -> L, L -> I, else I.
 * @param {string|null} eligibleLevel
 * @returns {'I'|'L'|'U'|'O'}
 */
function oneLevelDown(eligibleLevel) {
  const lvl = normalizeLevel(eligibleLevel);
  if (lvl === 'O') return 'U';
  if (lvl === 'U') return 'L';
  if (lvl === 'L') return 'I';
  return 'I';
}

/**
 * Computes full Production Questionnaire + Gemba + Overall + After-Evaluation fields.
 */
function computeProductionEvaluation({
  eligibleLevel,
  safety,
  process: processMark,
  quality,
  ciTpm,
  system,
  safety5s,
  sopWiCheck
}) {
  const questVals = [safety, processMark, quality, ciTpm, system].filter(v => v !== null && v !== undefined);
  const hasQuest = questVals.length > 0;
  const knowledgeMark = hasQuest ? questVals.reduce((a, b) => a + b, 0) : 0;
  const maxKnowledge = getKnowledgeMaxMarks(eligibleLevel);
  const knowledgePct = maxKnowledge > 0 ? knowledgeMark / maxKnowledge : 0;
  const knowledgeResult = evaluateTemplatePassFail(eligibleLevel, knowledgePct);

  const gembaVals = [safety5s, sopWiCheck].filter(v => v !== null && v !== undefined);
  const hasGemba = gembaVals.length > 0;
  const gembaMark = hasGemba ? gembaVals.reduce((a, b) => a + b, 0) : 0;
  const gembaPct = gembaMark / 35;
  const gembaResult = evaluateTemplatePassFail(eligibleLevel, gembaPct);

  const isEvaluated = hasQuest || hasGemba;
  const overallResult = (knowledgeResult === 'Pass' && gembaResult === 'Pass') ? 'Pass' : 'Fail';
  const afterEvaluationLevel = overallResult === 'Pass'
    ? (normalizeLevel(eligibleLevel) || 'I')
    : oneLevelDown(eligibleLevel);

  return {
    hasQuest,
    hasGemba,
    isEvaluated,
    knowledgeMark,
    maxKnowledge,
    knowledgePct,
    knowledgeResult,
    gembaMark,
    gembaPct,
    gembaResult,
    overallResult,
    afterEvaluationLevel
  };
}

/**
 * Computes completed months between two YYYY-MM-DD dates (matching Excel DATEDIF(G, H, "M")).
 * @param {string} dojStr
 * @param {string} assessDateStr
 * @returns {number|null}
 */
function computeCompletedMonths(dojStr, assessDateStr) {
  const d1 = toExcelDateObject(dojStr);
  const d2 = toExcelDateObject(assessDateStr || new Date().toISOString().slice(0, 10));
  if (!d1 || !d2) return null;
  if (d1.getTime() > d2.getTime()) return null;
  let months = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
  if (d2.getUTCDate() < d1.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Computes QA Experience Bracket matching the Excel CHOOSE(MATCH(...)) formula.
 * @param {number|null} months
 * @returns {string}
 */
function computeYearWiseExpBracket(months) {
  if (months === null || months === undefined || months < 0) return '';
  if (months < 3) return '0-3 months';
  if (months < 6) return '3-6 months';
  if (months < 9) return '6-9 months';
  if (months < 12) return '9-12 months';
  if (months < 24) return '1-2 years';
  if (months < 36) return '2-3 years';
  if (months < 48) return '3-4 years';
  if (months < 60) return '4-5 years';
  if (months < 72) return '5-6 years';
  if (months < 84) return '6-7 years';
  if (months < 96) return '7-8 years';
  if (months < 108) return '8-9 years';
  if (months < 120) return '9-10 years';
  return '10+ years';
}

/**
 * Computes QA Skill level as per Experience:
 * >48 months = O, >24 months = U, >3 months = L, else I (or 'Not Eligible' if DOJ > assessment date).
 * @param {string} dojStr
 * @param {string} assessDateStr
 * @returns {{ expMonths: number|null, yearExp: string, expSkillLevel: string }}
 */
function computeQaExperienceSkill(dojStr, assessDateStr) {
  const expMonths = computeCompletedMonths(dojStr, assessDateStr);
  if (expMonths === null) {
    return { expMonths: null, yearExp: '', expSkillLevel: 'Not Eligible' };
  }
  let expSkillLevel = 'I';
  if (expMonths > 48) expSkillLevel = 'O';
  else if (expMonths > 24) expSkillLevel = 'U';
  else if (expMonths > 3) expSkillLevel = 'L';
  return {
    expMonths,
    yearExp: computeYearWiseExpBracket(expMonths),
    expSkillLevel
  };
}

// ---------------------------------------------------------------------------
// 2. Safe ExcelJS Loader + Chart/Drawing Preservation Wrapper
// ---------------------------------------------------------------------------

/**
 * ExcelJS throws TypeError ("Cannot read properties of undefined (reading 'anchors')")
 * on workbooks whose embedded chart drawings omit the xdr: namespace prefix or use
 * leading '/xl/' relationship targets (such as Production's Plant Head 17.08 chart).
 *
 * This helper extracts any native chart/drawing files before loading into ExcelJS,
 * normalizes relationship paths for ExcelJS, and returns both the loaded Workbook
 * and a preservedParts bundle that re-attaches native charts identically on write.
 *
 * @param {Buffer} rawBuffer
 */
async function loadExcelJsWorkbookSafely(rawBuffer) {
  const originalZip = await JSZip.loadAsync(rawBuffer);
  const preservedCharts = {
    files: {},
    sheetDrawings: {}, // sheetPath -> { drawingTag, relXml }
    contentTypeOverrides: []
  };

  // Capture [Content_Types].xml chart/drawing overrides before stripping
  if (originalZip.file('[Content_Types].xml')) {
    const ctXml = await originalZip.file('[Content_Types].xml').async('string');
    const overrideMatches = ctXml.match(/<Override[^>]*PartName="\/xl\/(drawings|charts)\/[^"]*"[^>]*\/>/g) || [];
    preservedCharts.contentTypeOverrides = overrideMatches;
  }

  for (const name of Object.keys(originalZip.files)) {
    const entry = originalZip.files[name];
    if (!entry || entry.dir) continue;
    if (name.startsWith('xl/drawings/') || name.startsWith('xl/charts/')) {
      preservedCharts.files[name] = await entry.async('nodebuffer');
      originalZip.remove(name);
    }
  }

  // Strip drawing relationships from worksheet rels & <drawing .../> tags for ExcelJS load
  for (const name of Object.keys(originalZip.files)) {
    const entry = originalZip.files[name];
    if (!entry || entry.dir) continue;
    if (name.endsWith('.rels')) {
      let xml = await originalZip.file(name).async('string');
      const drawingRelMatches = xml.match(/<Relationship[^>]*Type="[^"]*\/(drawing|chart)"[^>]*\/>/g) || [];
      if (drawingRelMatches.length && name.startsWith('xl/worksheets/_rels/')) {
        const sheetFile = name.replace('xl/worksheets/_rels/', 'xl/worksheets/').replace('.rels', '');
        preservedCharts.sheetDrawings[sheetFile] = preservedCharts.sheetDrawings[sheetFile] || {};
        preservedCharts.sheetDrawings[sheetFile].rels = drawingRelMatches.map(r =>
          r.replace(/Target="\/xl\//g, 'Target="../')
        );
      }
      xml = xml.replace(/<Relationship[^>]*Type="[^"]*\/(drawing|chart)"[^>]*\/>/g, '');
      if (name === 'xl/_rels/workbook.xml.rels') {
        xml = xml.replace(/Target="\/xl\//g, 'Target="');
      } else if (name.startsWith('xl/worksheets/_rels/')) {
        xml = xml.replace(/Target="\/xl\//g, 'Target="../');
      }
      originalZip.file(name, xml);
    } else if (name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')) {
      let xml = await originalZip.file(name).async('string');
      const drawTagMatch = xml.match(/<drawing[^>]*\/>/);
      if (drawTagMatch) {
        preservedCharts.sheetDrawings[name] = preservedCharts.sheetDrawings[name] || {};
        preservedCharts.sheetDrawings[name].drawingTag = drawTagMatch[0];
        xml = xml.replace(/<drawing[^>]*\/>/g, '');
        originalZip.file(name, xml);
      }
    }
  }

  const sanitizedBuf = await originalZip.generateAsync({ type: 'nodebuffer' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sanitizedBuf);
  return { workbook, preservedCharts };
}

/**
 * Writes an ExcelJS workbook to Buffer, forces fullCalcOnLoad=true, strips any stale
 * calcChain.xml so Excel recalculates cleanly without repair warnings, and re-attaches
 * preserved native Excel charts/drawings (e.g. Plant Head 17.08 chart).
 *
 * @param {ExcelJS.Workbook} workbook
 * @param {any} preservedCharts
 * @returns {Promise<Buffer>}
 */
async function writeExcelJsWorkbookSafely(workbook, preservedCharts) {
  workbook.calcProperties = workbook.calcProperties || {};
  workbook.calcProperties.fullCalcOnLoad = true;

  const rawOut = await workbook.xlsx.writeBuffer();
  const outBuf = Buffer.isBuffer(rawOut) ? rawOut : Buffer.from(rawOut);

  const hasPreservedCharts = preservedCharts && Object.keys(preservedCharts.files || {}).length > 0;
  const outZip = await JSZip.loadAsync(outBuf);

  // Remove stale calcChain.xml if present so Excel cleanly rebuilds formula calculation order
  if (outZip.file('xl/calcChain.xml')) {
    outZip.remove('xl/calcChain.xml');
    if (outZip.file('xl/_rels/workbook.xml.rels')) {
      let wbRels = await outZip.file('xl/_rels/workbook.xml.rels').async('string');
      wbRels = wbRels.replace(/<Relationship[^>]*calcChain\.xml[^>]*\/>/g, '');
      outZip.file('xl/_rels/workbook.xml.rels', wbRels);
    }
    if (outZip.file('[Content_Types].xml')) {
      let ct = await outZip.file('[Content_Types].xml').async('string');
      ct = ct.replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
      outZip.file('[Content_Types].xml', ct);
    }
  }

  // Re-attach preserved native Excel charts & drawings byte-for-byte
  if (hasPreservedCharts) {
    for (const [filePath, buf] of Object.entries(preservedCharts.files)) {
      if (filePath.endsWith('.rels')) {
        const normalized = buf.toString('utf8').replace(/Target="\/xl\//g, 'Target="../');
        outZip.file(filePath, normalized);
      } else {
        outZip.file(filePath, buf);
      }
    }

    for (const [sheetPath, info] of Object.entries(preservedCharts.sheetDrawings || {})) {
      if (!info.drawingTag || !info.rels || !info.rels.length) continue;
      if (!outZip.file(sheetPath)) continue;

      const relsPath = sheetPath.replace('xl/worksheets/', 'xl/worksheets/_rels/') + '.rels';
      let relXml = outZip.file(relsPath)
        ? await outZip.file(relsPath).async('string')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

      // Compute a conflict-free rId in case ExcelJS added relationships on the sheet
      const existingIds = new Set([...relXml.matchAll(/Id="(rId\d+)"/g)].map(m => m[1]));
      let newRId = 'rId1';
      const origIdMatch = info.drawingTag.match(/r:id="(rId\d+)"/);
      if (origIdMatch && !existingIds.has(origIdMatch[1])) {
        newRId = origIdMatch[1];
      } else {
        let n = 1;
        while (existingIds.has(`rId${n}`)) n++;
        newRId = `rId${n}`;
      }

      const patchedRel = info.rels[0].replace(/Id="rId\d+"/, `Id="${newRId}"`);
      if (!relXml.includes(patchedRel)) {
        relXml = relXml.replace('</Relationships>', `${patchedRel}</Relationships>`);
        outZip.file(relsPath, relXml);
      }

      let sheetXml = await outZip.file(sheetPath).async('string');
      const patchedDrawingTag = info.drawingTag.replace(/r:id="rId\d+"/, `r:id="${newRId}"`);
      if (!sheetXml.includes('<drawing ')) {
        sheetXml = sheetXml.replace('</worksheet>', `${patchedDrawingTag}</worksheet>`);
        outZip.file(sheetPath, sheetXml);
      }
    }

    if (outZip.file('[Content_Types].xml') && preservedCharts.contentTypeOverrides.length) {
      let ctXml = await outZip.file('[Content_Types].xml').async('string');
      for (const ov of preservedCharts.contentTypeOverrides) {
        const partMatch = ov.match(/PartName="([^"]+)"/);
        if (partMatch && !ctXml.includes(partMatch[1])) {
          ctXml = ctXml.replace('</Types>', `${ov}</Types>`);
        }
      }
      outZip.file('[Content_Types].xml', ctXml);
    }
  }

  return await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// 3. Workbook Auto-Detection & Parsing (Production + QA)
// ---------------------------------------------------------------------------

/**
 * Detects whether a loaded workbook is a Production or QA template workbook.
 * @param {ExcelJS.Workbook} workbook
 * @param {'production'|'qa'|'auto'} [forcedType]
 * @returns {'production'|'qa'}
 */
function detectWorkbookType(workbook, forcedType) {
  if (forcedType === 'production' || forcedType === 'qa') return forcedType;
  const sheetNames = workbook.worksheets.map(s => s.name.trim().toLowerCase());
  if (
    sheetNames.includes('left') ||
    sheetNames.includes('2025-2026 comp') ||
    sheetNames.includes('plant head 17.08') ||
    sheetNames.includes('abstract')
  ) {
    return 'production';
  }
  if (
    sheetNames.includes('sec wise summary') ||
    sheetNames.includes('iluo abstract (2)') ||
    sheetNames.includes('exp wise summary') ||
    sheetNames.includes('dept wise')
  ) {
    return 'qa';
  }
  // Fallback: inspect Name list header row
  const nl = workbook.getWorksheet('Name list') || workbook.worksheets[0];
  if (nl) {
    const r1J = String(unwrapCellValue(nl.getRow(1).getCell(10).value) || '').toLowerCase();
    const r2H = String(unwrapCellValue(nl.getRow(2).getCell(8).value) || '').toLowerCase();
    if (r1J.includes('quest') || r2H.includes('eligible')) return 'production';
  }
  return 'qa';
}

/**
 * Parses a Production sheet ('Name list' or 'Left') where Row 1 = group headers,
 * Row 2 = column headers, and Row 3+ = employee rows.
 */
function parseProductionSheet(ws, isLeftSheet, warnings) {
  if (!ws) return [];
  const rowsByEmpNo = new Map();
  let nilCount = 0;

  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const empNo = normalizeEmpNo(row.getCell(2).value);
    if (!empNo || empNo === 'EMP NO' || empNo === '0') continue;

    const name = String(unwrapCellValue(row.getCell(3).value) || '').trim();
    const dept = String(unwrapCellValue(row.getCell(4).value) || 'PRODUCTION').trim();
    const section = String(unwrapCellValue(row.getCell(5).value) || '').trim();
    const doj = formatExcelDate(row.getCell(6).value);
    const eligibleLevel = normalizeLevel(row.getCell(8).value) || 'L';
    const currentLevel2025 = normalizeLevel(row.getCell(9).value);

    // Questionnaire marks (J..N)
    const rawJ = row.getCell(10).value;
    const rawK = row.getCell(11).value;
    const rawL = row.getCell(12).value;
    const rawM = row.getCell(13).value;
    const rawN = row.getCell(14).value;

    const hadNilMarker = isNilMarker(rawJ) || isNilMarker(rawK) || isNilMarker(rawL) || isNilMarker(rawM) || isNilMarker(rawN);
    if (hadNilMarker) nilCount++;

    const safety = parseExcelNumberOrNull(rawJ);
    const processMark = parseExcelNumberOrNull(rawK);
    const quality = parseExcelNumberOrNull(rawL);
    const ciTpm = parseExcelNumberOrNull(rawM);
    const system = parseExcelNumberOrNull(rawN);

    // Gemba marks (S..T)
    const safety5s = parseExcelNumberOrNull(row.getCell(19).value);
    const sopWiCheck = parseExcelNumberOrNull(row.getCell(20).value);

    const recheck = String(unwrapCellValue(row.getCell(26).value) || '').trim();

    const computed = computeProductionEvaluation({
      eligibleLevel,
      safety,
      process: processMark,
      quality,
      ciTpm,
      system,
      safety5s,
      sopWiCheck
    });

    const parsedRecord = {
      rowNumber: r,
      empNo,
      name,
      dept,
      section,
      doj,
      eligibleLevel,
      currentLevel2025,
      isLeft: Boolean(isLeftSheet),
      questMarks: {
        safety,
        process: processMark,
        quality,
        ciTpm,
        system,
        hadNilMarker,
        knowledgeMark: computed.hasQuest ? computed.knowledgeMark : null,
        maxMarks: computed.maxKnowledge,
        knowledgePct: computed.hasQuest ? Math.round(computed.knowledgePct * 100) : null,
        result: computed.hasQuest ? computed.knowledgeResult : null
      },
      gembaMarks: {
        safety5s,
        sopWiCheck,
        skillAssessmentMark: computed.hasGemba ? computed.gembaMark : null,
        maxMarks: 35,
        skillAssessmentPct: computed.hasGemba ? Math.round(computed.gembaPct * 100) : null,
        result: computed.hasGemba ? computed.gembaResult : null
      },
      isEvaluated: computed.isEvaluated,
      overallResult: computed.isEvaluated ? computed.overallResult : null,
      afterEvaluationLevel: computed.isEvaluated ? computed.afterEvaluationLevel : null,
      recheck
    };

    if (rowsByEmpNo.has(empNo)) {
      const prev = rowsByEmpNo.get(empNo);
      warnings.push(`Duplicate EMP NO "${empNo}" in "${ws.name}" (rows ${prev.rowNumber} & ${r}) — merged keeping evaluated row.`);
      // Prefer whichever row has evaluation marks; otherwise keep latest row
      if (parsedRecord.isEvaluated || !prev.isEvaluated) {
        rowsByEmpNo.set(empNo, parsedRecord);
      }
    } else {
      rowsByEmpNo.set(empNo, parsedRecord);
    }
  }

  if (nilCount > 0) {
    warnings.push(`"${ws.name}": Converted ${nilCount} "NIL" questionnaire cell entries safely to null.`);
  }

  return Array.from(rowsByEmpNo.values());
}

/**
 * Parses the QA workbook ('Name list', Row 1 = headers, Row 2+ = employee rows).
 */
function parseQaSheet(ws, warnings) {
  if (!ws) return [];
  const rowsByEmpNo = new Map();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const empNo = normalizeEmpNo(row.getCell(2).value);
    if (!empNo || empNo === 'EMP NO' || empNo === '0') continue;

    const name = String(unwrapCellValue(row.getCell(3).value) || '').trim();
    const dept = String(unwrapCellValue(row.getCell(4).value) || 'QUALITY CONTROL').trim();
    const section = String(unwrapCellValue(row.getCell(5).value) || '').trim();
    const qualification = String(unwrapCellValue(row.getCell(6).value) || '').trim();
    const doj = formatExcelDate(row.getCell(7).value);
    const assessmentDate = formatExcelDate(row.getCell(8).value) || '2026-06-30';

    const expCalc = computeQaExperienceSkill(doj, assessmentDate);
    const sheetExpLevel = String(unwrapCellValue(row.getCell(11).value) || '').trim();
    const eligibleLevel = normalizeLevel(sheetExpLevel) || normalizeLevel(expCalc.expSkillLevel) || 'I';
    const assess2025Level = normalizeLevel(row.getCell(12).value);

    if (expCalc.expMonths === null && doj) {
      warnings.push(`Row ${r} (${empNo}): DOJ "${doj}" is after assessment date "${assessmentDate}" (marked Not Eligible).`);
    }

    const parsedRecord = {
      rowNumber: r,
      empNo,
      name,
      dept,
      section,
      qualification,
      doj,
      assessmentDate,
      expCount: expCalc.expMonths,
      yearExp: expCalc.yearExp,
      eligibleLevel,
      expSkillLevelRaw: expCalc.expSkillLevel,
      currentLevel2025: assess2025Level,
      isLeft: false
    };

    if (rowsByEmpNo.has(empNo)) {
      const prev = rowsByEmpNo.get(empNo);
      warnings.push(`Duplicate EMP NO "${empNo}" in QA "Name list" (rows ${prev.rowNumber} & ${r}) — kept latest row.`);
    }
    rowsByEmpNo.set(empNo, parsedRecord);
  }

  return Array.from(rowsByEmpNo.values());
}

/**
 * Parses an uploaded Excel buffer into a normalized structured payload for preview/commit.
 * @param {Buffer} buffer
 * @param {'production'|'qa'|'auto'} [forcedType='auto']
 */
async function parseUploadedWorkbook(buffer, forcedType = 'auto') {
  const { workbook } = await loadExcelJsWorkbookSafely(buffer);
  const fileType = detectWorkbookType(workbook, forcedType);
  const warnings = [];

  if (fileType === 'production') {
    const activeSheet = workbook.getWorksheet('Name list');
    if (!activeSheet) {
      throw new Error('Production workbook is missing required "Name list" worksheet.');
    }
    const leftSheet = workbook.getWorksheet('Left');
    const activeRows = parseProductionSheet(activeSheet, false, warnings);
    const leftRows = leftSheet ? parseProductionSheet(leftSheet, true, warnings) : [];
    return {
      fileType: 'production',
      sheetsFound: workbook.worksheets.map(s => s.name),
      activeRows,
      leftRows,
      warnings
    };
  }

  const qaSheet = workbook.getWorksheet('Name list');
  if (!qaSheet) {
    throw new Error('QA workbook is missing required "Name list" worksheet.');
  }
  const activeRows = parseQaSheet(qaSheet, warnings);
  return {
    fileType: 'qa',
    sheetsFound: workbook.worksheets.map(s => s.name),
    activeRows,
    leftRows: [],
    warnings
  };
}

// ---------------------------------------------------------------------------
// 4. Upsert Preview & Commit Engine
// ---------------------------------------------------------------------------

/**
 * Helper to determine if an employee belongs to QA / Quality Control.
 */
function isQaDepartment(dept) {
  const d = String(dept || '').toUpperCase();
  return d.includes('QUALITY') || d === 'QC' || d === 'QA';
}

/**
 * Runs the upsert logic in memory and returns both the mutated copies AND a rich diff summary.
 * Callers can inspect the summary for Preview mode, or persist `nextEmployees`, `nextRecords`,
 * `nextOjtEvaluations` for Commit mode.
 */
function buildWorkbookSyncPlan(parsed, existingEmployees = [], existingRecords = {}, existingOjt = {}) {
  // Deduplicate existing employee directory by normalized EMP NO (preserving latest entry)
  const nextEmployees = [];
  const empIndexByKey = new Map();
  for (const emp of existingEmployees || []) {
    const copy = { ...emp };
    const key = normalizeEmpNo(copy.empNo);
    if (!key) continue;
    copy.empNo = key;
    if (empIndexByKey.has(key)) {
      nextEmployees[empIndexByKey.get(key)] = { ...nextEmployees[empIndexByKey.get(key)], ...copy };
    } else {
      empIndexByKey.set(key, nextEmployees.length);
      nextEmployees.push(copy);
    }
  }
  const nextRecords = { ...existingRecords };
  const nextOjt = { ...existingOjt };

  let matchedUpdated = 0;
  let newEmployeesAdded = 0;
  let leftMarkedInactive = 0;
  let marksUpdatedCount = 0;
  let skillLevelsUpdatedCount = 0;
  const sampleChanges = [];
  const warnings = [...(parsed.warnings || [])];

  const pushSample = (entry) => {
    if (sampleChanges.length < 30) sampleChanges.push(entry);
  };

  if (parsed.fileType === 'production') {
    const activeEmpSet = new Set(parsed.activeRows.map(r => r.empNo));

    // A. Process Active Rows ('Name list')
    for (const row of parsed.activeRows) {
      const key = row.empNo;
      const existingIdx = empIndexByKey.get(key);
      const isNew = existingIdx === undefined;
      const prev = isNew ? null : nextEmployees[existingIdx];

      const prevLevel = prev ? (prev.currentLevel || prev.skillLevelAssess2025 || 'I') : null;
      // Rule: Use Y (afterEvaluationLevel) as Current Skill Level 2026 when evaluated;
      // otherwise keep existing current level (or fallback to I: Current skill level 2025).
      const resolvedCurrentLevel = row.isEvaluated && row.afterEvaluationLevel
        ? row.afterEvaluationLevel
        : (prev && normalizeLevel(prev.currentLevel)) || row.currentLevel2025 || 'I';

      const updatedEmp = {
        ...(prev || {}),
        empNo: row.empNo,
        name: row.name || (prev && prev.name) || '',
        dept: row.dept || (prev && prev.dept) || 'PRODUCTION',
        // Preserve existing QA section formatting for QA employees if present, while storing exact Production template section
        section: (prev && isQaDepartment(row.dept) && prev.section) ? prev.section : (row.section || (prev && prev.section) || ''),
        templateSection: row.section || (prev && prev.templateSection) || '',
        doj: row.doj || (prev && prev.doj) || '',
        targetLevel: row.eligibleLevel || (prev && prev.targetLevel) || 'L',
        eligibleLevel: row.eligibleLevel || (prev && prev.eligibleLevel) || 'L',
        skillLevelAssess2025: row.currentLevel2025 || (prev && prev.skillLevelAssess2025) || resolvedCurrentLevel,
        currentLevel: resolvedCurrentLevel,
        isLeft: false,
        status: 'ACTIVE',
        recheck: row.recheck || '',
        excelQuestMarks: row.questMarks,
        excelGembaMarks: row.gembaMarks,
        excelOverallResult: row.overallResult,
        afterEvaluationLevel: row.afterEvaluationLevel,
        lastExcelSyncAt: new Date().toISOString()
      };

      if (isNew) {
        empIndexByKey.set(key, nextEmployees.length);
        nextEmployees.push(updatedEmp);
        newEmployeesAdded++;
      } else {
        nextEmployees[existingIdx] = updatedEmp;
        matchedUpdated++;
      }

      if (prevLevel !== resolvedCurrentLevel) {
        skillLevelsUpdatedCount++;
      }

      // Sync Questionnaire marks into assessment_records when evaluated
      if (row.questMarks && row.questMarks.knowledgeMark !== null) {
        marksUpdatedCount++;
        const { submittedQuestions: _droppedLegacyQs, ...prevRec } = nextRecords[key] || {};
        nextRecords[key] = {
          ...prevRec,
          empNo: key,
          name: updatedEmp.name,
          dept: updatedEmp.dept,
          section: updatedEmp.section,
          targetLevel: updatedEmp.targetLevel,
          currentLevel: resolvedCurrentLevel,
          isCompleted: true,
          status: row.questMarks.result === 'Pass' ? 'Passed' : 'Failed',
          isPassed: row.questMarks.result === 'Pass',
          totalMark: row.questMarks.knowledgeMark,
          maxMarks: row.questMarks.maxMarks,
          markPct: row.questMarks.knowledgePct,
          safetyMark: row.questMarks.safety !== null ? row.questMarks.safety : 0,
          categoryMarks: {
            Safety: row.questMarks.safety,
            Process: row.questMarks.process,
            Quality: row.questMarks.quality,
            'CI & TPM': row.questMarks.ciTpm,
            System: row.questMarks.system
          },
          switchedLevel: row.afterEvaluationLevel || undefined,
          overallResult: row.overallResult,
          source: 'excel_sync_production',
          syncedAt: new Date().toISOString()
        };
      }

      // Sync Gemba marks into ojt_evaluations when evaluated
      if (row.gembaMarks && row.gembaMarks.skillAssessmentMark !== null) {
        const prevOjt = nextOjt[key] || {};
        nextOjt[key] = {
          ...prevOjt,
          empNo: key,
          name: updatedEmp.name,
          dept: updatedEmp.dept,
          section: updatedEmp.section,
          safety5sScore: row.gembaMarks.safety5s,
          sopWiScore: row.gembaMarks.sopWiCheck,
          totalScore: row.gembaMarks.skillAssessmentMark,
          maxScore: 35,
          percentage: row.gembaMarks.skillAssessmentPct,
          result: row.gembaMarks.result,
          overallResult: row.overallResult,
          source: 'excel_sync_production',
          syncedAt: new Date().toISOString()
        };
      }

      if (isNew || prevLevel !== resolvedCurrentLevel || row.isEvaluated) {
        pushSample({
          empNo: key,
          name: updatedEmp.name,
          dept: updatedEmp.dept,
          section: updatedEmp.templateSection || updatedEmp.section,
          action: isNew ? 'NEW' : 'UPDATED',
          levelChange: `${prevLevel || '—'} → ${resolvedCurrentLevel}`,
          questTotal: row.questMarks.knowledgeMark !== null ? `${row.questMarks.knowledgeMark}/${row.questMarks.maxMarks} (${row.questMarks.knowledgePct}%)` : '—',
          gembaTotal: row.gembaMarks.skillAssessmentMark !== null ? `${row.gembaMarks.skillAssessmentMark}/35 (${row.gembaMarks.skillAssessmentPct}%)` : '—',
          overallResult: row.overallResult || 'Pending'
        });
      }
    }

    // B. Process Left Sheet ('Left') — mark inactive so they don't count toward active headcount
    for (const row of parsed.leftRows) {
      const key = row.empNo;
      if (activeEmpSet.has(key)) {
        warnings.push(`EMP NO "${key}" appears in both "Name list" and "Left" sheets — kept Active.`);
        continue;
      }
      const existingIdx = empIndexByKey.get(key);
      const isNew = existingIdx === undefined;
      const prev = isNew ? null : nextEmployees[existingIdx];

      const leftEmp = {
        ...(prev || {}),
        empNo: row.empNo,
        name: row.name || (prev && prev.name) || '',
        dept: row.dept || (prev && prev.dept) || 'PRODUCTION',
        section: row.section || (prev && prev.section) || '',
        templateSection: row.section || (prev && prev.templateSection) || '',
        doj: row.doj || (prev && prev.doj) || '',
        targetLevel: row.eligibleLevel || (prev && prev.targetLevel) || 'L',
        eligibleLevel: row.eligibleLevel || (prev && prev.eligibleLevel) || 'L',
        skillLevelAssess2025: row.currentLevel2025 || (prev && prev.skillLevelAssess2025) || 'I',
        currentLevel: (row.isEvaluated && row.afterEvaluationLevel) || row.currentLevel2025 || (prev && prev.currentLevel) || 'I',
        isLeft: true,
        status: 'LEFT',
        recheck: row.recheck || '',
        excelQuestMarks: row.questMarks,
        excelGembaMarks: row.gembaMarks,
        excelOverallResult: row.overallResult,
        afterEvaluationLevel: row.afterEvaluationLevel,
        lastExcelSyncAt: new Date().toISOString()
      };

      if (isNew) {
        empIndexByKey.set(key, nextEmployees.length);
        nextEmployees.push(leftEmp);
      } else {
        nextEmployees[existingIdx] = leftEmp;
      }
      leftMarkedInactive++;
    }
  } else {
    // QA Workbook Sync
    for (const row of parsed.activeRows) {
      const key = row.empNo;
      const existingIdx = empIndexByKey.get(key);
      const isNew = existingIdx === undefined;
      const prev = isNew ? null : nextEmployees[existingIdx];

      const prevLevel = prev ? (prev.currentLevel || prev.skillLevelAssess2025 || 'I') : null;
      const has2026Evaluation = Boolean(prev && normalizeLevel(prev.afterEvaluationLevel));
      const resolvedCurrentLevel = has2026Evaluation
        ? normalizeLevel(prev.afterEvaluationLevel)
        : (row.currentLevel2025 || (prev && normalizeLevel(prev.currentLevel)) || 'I');

      const updatedEmp = {
        ...(prev || {}),
        empNo: row.empNo,
        name: row.name || (prev && prev.name) || '',
        dept: row.dept || (prev && prev.dept) || 'QUALITY CONTROL',
        section: row.section || (prev && prev.section) || '',
        qaTemplateSection: row.section || (prev && prev.qaTemplateSection) || '',
        templateSection: (prev && prev.templateSection) || row.section || '',
        qualification: row.qualification || (prev && prev.qualification) || '',
        doj: row.doj || (prev && prev.doj) || '',
        assessmentDate: row.assessmentDate || (prev && prev.assessmentDate) || '2026-06-30',
        expCount: row.expCount !== null ? row.expCount : (prev ? prev.expCount : ''),
        yearExp: row.yearExp || (prev && prev.yearExp) || '',
        targetLevel: row.eligibleLevel || (prev && prev.targetLevel) || 'L',
        eligibleLevel: row.eligibleLevel || (prev && prev.eligibleLevel) || 'L',
        skillLevelExpBased: row.expSkillLevelRaw || row.eligibleLevel,
        skillLevelAssess2025: row.currentLevel2025 || (prev && prev.skillLevelAssess2025) || '',
        currentLevel: resolvedCurrentLevel,
        isLeft: false,
        status: 'ACTIVE',
        lastExcelSyncAt: new Date().toISOString()
      };

      if (isNew) {
        empIndexByKey.set(key, nextEmployees.length);
        nextEmployees.push(updatedEmp);
        newEmployeesAdded++;
      } else {
        nextEmployees[existingIdx] = updatedEmp;
        matchedUpdated++;
      }

      if (prevLevel !== resolvedCurrentLevel) {
        skillLevelsUpdatedCount++;
      }

      pushSample({
        empNo: key,
        name: updatedEmp.name,
        dept: updatedEmp.dept,
        section: updatedEmp.qaTemplateSection || updatedEmp.section,
        action: isNew ? 'NEW' : 'UPDATED',
        levelChange: `${prevLevel || '—'} → ${resolvedCurrentLevel}`,
        questTotal: row.expSkillLevelRaw ? `Exp Target: ${row.expSkillLevelRaw}` : '—',
        gembaTotal: row.yearExp || '—',
        overallResult: row.currentLevel2025 ? `2025: ${row.currentLevel2025}` : 'Not Assessed'
      });
    }
  }

  const activeHeadcount = nextEmployees.filter(e => !e.isLeft && e.status !== 'LEFT').length;
  const leftHeadcount = nextEmployees.filter(e => e.isLeft || e.status === 'LEFT').length;

  return {
    nextEmployees,
    nextRecords,
    nextOjt,
    summary: {
      fileType: parsed.fileType,
      sheetsFound: parsed.sheetsFound,
      totalParsedActive: parsed.activeRows.length,
      totalParsedLeft: parsed.leftRows.length,
      matchedUpdated,
      newEmployeesAdded,
      leftMarkedInactive,
      marksUpdatedCount,
      skillLevelsUpdatedCount,
      activeHeadcount,
      leftHeadcount,
      warnings,
      sampleChanges
    }
  };
}

// ---------------------------------------------------------------------------
// 5. Exact Template-Cloning Excel Export Engine (ExcelJS)
// ---------------------------------------------------------------------------

/**
 * Deep-clones an ExcelJS cell's style (font, fill, border, alignment, numFmt).
 */
function cloneStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : {};
}

/**
 * Extracts a row's cell styles across columns 1..maxCol for clean row cloning.
 */
function captureRowStyleTemplate(ws, rowIndex, maxCol) {
  const row = ws.getRow(rowIndex);
  const styles = {};
  for (let c = 1; c <= maxCol; c++) {
    styles[c] = cloneStyle(row.getCell(c).style);
  }
  return { height: row.height, styles };
}

/**
 * Resolves the latest Questionnaire marks (Safety, Process, Quality, CI & TPM, System)
 * for an employee from live website assessment records + synced Excel marks.
 */
function resolveEmployeeQuestMarks(emp, record) {
  const fromExcel = (emp && emp.excelQuestMarks) || {};
  // Prefer live portal exam record if completed and has categoryMarks (and not simply an older mirror)
  if (record && record.isCompleted && record.categoryMarks && typeof record.categoryMarks === 'object') {
    const cm = record.categoryMarks;
    const safety = parseExcelNumberOrNull(cm.Safety ?? cm.safety ?? record.safetyMark);
    const processMark = parseExcelNumberOrNull(cm.Process ?? cm['Process '] ?? cm.process ?? cm['Process / Technical']);
    const quality = parseExcelNumberOrNull(cm.Quality ?? cm.quality ?? cm['Quality & Defects']);
    const ciTpm = parseExcelNumberOrNull(cm['CI & TPM'] ?? cm.ciTpm ?? cm.CI ?? cm['Continuous Improvement']);
    const system = parseExcelNumberOrNull(cm.System ?? cm.system ?? cm['Systems & Standards']);

    const anyPresent = [safety, processMark, quality, ciTpm, system].some(v => v !== null);
    if (anyPresent) {
      return { safety, process: processMark, quality, ciTpm, system, hadNilMarker: false };
    }
  }
  return {
    safety: parseExcelNumberOrNull(fromExcel.safety),
    process: parseExcelNumberOrNull(fromExcel.process),
    quality: parseExcelNumberOrNull(fromExcel.quality),
    ciTpm: parseExcelNumberOrNull(fromExcel.ciTpm),
    system: parseExcelNumberOrNull(fromExcel.system),
    hadNilMarker: Boolean(fromExcel.hadNilMarker)
  };
}

/**
 * Resolves the latest Gemba marks (Safety/ 5S, SOP's/ WI CHECK) from live OJT evaluations + synced Excel marks.
 */
function resolveEmployeeGembaMarks(emp, ojt) {
  const fromExcel = (emp && emp.excelGembaMarks) || {};
  if (ojt && typeof ojt === 'object') {
    const s5 = parseExcelNumberOrNull(ojt.safety5sScore ?? ojt.safety5s ?? ojt.safetyScore);
    const sop = parseExcelNumberOrNull(ojt.sopWiScore ?? ojt.sopWiCheck ?? ojt.processScore);
    if (s5 !== null || sop !== null) {
      return { safety5s: s5, sopWiCheck: sop };
    }
  }
  return {
    safety5s: parseExcelNumberOrNull(fromExcel.safety5s),
    sopWiCheck: parseExcelNumberOrNull(fromExcel.sopWiCheck)
  };
}

/**
 * Writes a list of employees into a Production worksheet ('Name list' or 'Left')
 * starting at Row 3, preserving exact styles and live Excel formulas on every row,
 * and clearing any leftover rows below the final employee.
 */
function populateProductionSheet(ws, employeesList, recordsMap, ojtMap) {
  const maxCol = 27; // A..AA
  const templateRowStyle = captureRowStyleTemplate(ws, 3, maxCol);
  const previousLastRow = Math.max(ws.rowCount, 3);

  employeesList.forEach((emp, idx) => {
    const r = 3 + idx;
    const row = ws.getRow(r);
    if (templateRowStyle.height) row.height = templateRowStyle.height;

    // Apply cloned cell styles across A..Z
    for (let c = 1; c <= 26; c++) {
      if (templateRowStyle.styles[c]) {
        row.getCell(c).style = cloneStyle(templateRowStyle.styles[c]);
      }
    }

    const key = normalizeEmpNo(emp.empNo);
    const rec = recordsMap[key] || recordsMap[emp.empNo] || null;
    const ojt = ojtMap[key] || ojtMap[emp.empNo] || null;

    const eligible = normalizeLevel(emp.eligibleLevel || emp.targetLevel) || 'L';
    const level2025 = normalizeLevel(emp.skillLevelAssess2025 || emp.currentLevel) || '';
    const sectionName = emp.templateSection || emp.section || '';
    const dojObj = toExcelDateObject(emp.doj);

    const quest = resolveEmployeeQuestMarks(emp, rec);
    const gemba = resolveEmployeeGembaMarks(emp, ojt);

    const calc = computeProductionEvaluation({
      eligibleLevel: eligible,
      safety: quest.safety,
      process: quest.process,
      quality: quest.quality,
      ciTpm: quest.ciTpm,
      system: quest.system,
      safety5s: gemba.safety5s,
      sopWiCheck: gemba.sopWiCheck
    });

    // Preserve numeric EMP NOs as numbers when purely digits (matching original template), else string
    const empNoCellVal = /^\d+$/.test(key) ? Number(key) : key;

    // --- INPUT COLUMNS ONLY (B–F, H–N, S–T, Z) ---
    row.getCell(2).value = empNoCellVal;                             // B: EMP NO
    row.getCell(3).value = emp.name || '';                           // C: NAME
    row.getCell(4).value = emp.dept || 'PRODUCTION';                 // D: DEPT
    row.getCell(5).value = sectionName;                              // E: SECTION
    row.getCell(6).value = dojObj || (emp.doj || null);              // F: DOJ
    row.getCell(8).value = eligible;                                 // H: Eligible skill level
    row.getCell(9).value = level2025 || null;                        // I: Current skill level 2025

    // Quest inputs (J..N)
    row.getCell(10).value = quest.safety !== null ? quest.safety : (quest.hadNilMarker ? 'NIL' : null);
    row.getCell(11).value = quest.process !== null ? quest.process : null;
    row.getCell(12).value = quest.quality !== null ? quest.quality : null;
    row.getCell(13).value = quest.ciTpm !== null ? quest.ciTpm : null;
    row.getCell(14).value = quest.system !== null ? quest.system : null;

    // Spacer R (18) kept empty
    row.getCell(18).value = null;

    // Gemba inputs (S..T)
    row.getCell(19).value = gemba.safety5s !== null ? gemba.safety5s : null;
    row.getCell(20).value = gemba.sopWiCheck !== null ? gemba.sopWiCheck : null;

    // Recheck (Z)
    row.getCell(26).value = emp.recheck || null;
    // Clear legacy external link in AA (27)
    row.getCell(27).value = null;

    // --- LIVE FORMULA COLUMNS (A, G, O, P, Q, U, V, W, X, Y) ---
    row.getCell(1).value = { formula: 'ROW()-2', result: idx + 1 };
    row.getCell(7).value = { formula: `NOW()-F${r}` };
    row.getCell(15).value = { formula: `SUM(J${r}:N${r})`, result: calc.knowledgeMark };
    row.getCell(16).value = {
      formula: `O${r}/IF(H${r}="L",20,IF(H${r}="U",30,IF(H${r}="O",40,IF(H${r}="I",20,""))))`,
      result: calc.knowledgePct
    };
    row.getCell(17).value = {
      formula: `IF(AND(H${r}="L", P${r}>=50%), "Pass",\nIF(AND(H${r}="U", P${r}>=60%), "Pass",\nIF(AND(H${r}="O", P${r}>=75%), "Pass", "Fail")))`,
      result: calc.knowledgeResult
    };
    row.getCell(21).value = { formula: `SUM(S${r}:T${r})`, result: calc.gembaMark };
    row.getCell(22).value = {
      formula: `U${r}/IF(H${r}="L",35,IF(H${r}="U",35,IF(H${r}="O",35,IF(H${r}="I",35,""))))`,
      result: calc.gembaPct
    };
    row.getCell(23).value = {
      formula: `IF(AND(H${r}="L", V${r}>=50%), "Pass",\nIF(AND(H${r}="U", V${r}>=60%), "Pass",\nIF(AND(H${r}="O", V${r}>=75%), "Pass", "Fail")))`,
      result: calc.gembaResult
    };
    row.getCell(24).value = {
      formula: `IF(AND(Q${r}="Pass", W${r}="Pass"), "Pass", "Fail")`,
      result: calc.overallResult
    };
    row.getCell(25).value = {
      formula: `IF($X${r}="Pass",$H${r},\nIF(H${r}="L","I",\nIF(H${r}="U","L",\nIF(H${r}="O","U",\n"I"))))`,
      result: calc.afterEvaluationLevel
    };

    row.commit();
  });

  // Clear any extra leftover rows if new dataset has fewer rows than the template
  const newLastRow = 2 + employeesList.length;
  for (let r = newLastRow + 1; r <= previousLastRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      row.getCell(c).value = null;
    }
    row.commit();
  }
}

/**
 * Generates an exact template-cloned Production Excel workbook (.xlsx) Buffer
 * preserving all 6 sheets (`Plant Head 17.08`, `2025-2026 comp`, `Abstract`, `Name list`,
 * `Left`, `Entry sheet`), native Chart on `Plant Head 17.08`, merged headers, colors,
 * borders, column widths, and live formulas.
 */
async function exportProductionWorkbookBuffer(employees = [], records = {}, ojtRecords = {}) {
  if (!fs.existsSync(PRODUCTION_TEMPLATE_PATH)) {
    throw new Error('Base Production template not found at /public/templates/production_template.xlsx');
  }

  const templateBuf = fs.readFileSync(PRODUCTION_TEMPLATE_PATH);
  const { workbook, preservedCharts } = await loadExcelJsWorkbookSafely(templateBuf);

  const nameListWs = workbook.getWorksheet('Name list');
  const leftWs = workbook.getWorksheet('Left');
  if (!nameListWs) throw new Error('Production template missing "Name list" worksheet.');

  // Preserve original template row order for existing employees, appending newly added employees at the end
  const templateOrderActive = [];
  for (let r = 3; r <= nameListWs.rowCount; r++) {
    const id = normalizeEmpNo(nameListWs.getRow(r).getCell(2).value);
    if (id && !templateOrderActive.includes(id)) templateOrderActive.push(id);
  }
  const templateOrderLeft = [];
  if (leftWs) {
    for (let r = 3; r <= leftWs.rowCount; r++) {
      const id = normalizeEmpNo(leftWs.getRow(r).getCell(2).value);
      if (id && !templateOrderLeft.includes(id)) templateOrderLeft.push(id);
    }
  }

  const orderIndexActive = new Map(templateOrderActive.map((id, i) => [id, i]));
  const orderIndexLeft = new Map(templateOrderLeft.map((id, i) => [id, i]));

  const activeEmps = employees
    .filter(e => !e.isLeft && e.status !== 'LEFT')
    .sort((a, b) => {
      const ia = orderIndexActive.has(normalizeEmpNo(a.empNo)) ? orderIndexActive.get(normalizeEmpNo(a.empNo)) : 999999;
      const ib = orderIndexActive.has(normalizeEmpNo(b.empNo)) ? orderIndexActive.get(normalizeEmpNo(b.empNo)) : 999999;
      return ia - ib;
    });

  const leftEmps = employees
    .filter(e => e.isLeft || e.status === 'LEFT')
    .sort((a, b) => {
      const ia = orderIndexLeft.has(normalizeEmpNo(a.empNo)) ? orderIndexLeft.get(normalizeEmpNo(a.empNo)) : 999999;
      const ib = orderIndexLeft.has(normalizeEmpNo(b.empNo)) ? orderIndexLeft.get(normalizeEmpNo(b.empNo)) : 999999;
      return ia - ib;
    });

  populateProductionSheet(nameListWs, activeEmps, records || {}, ojtRecords || {});
  if (leftWs && leftEmps.length > 0) {
    populateProductionSheet(leftWs, leftEmps, records || {}, ojtRecords || {});
  }

  return await writeExcelJsWorkbookSafely(workbook, preservedCharts);
}

/**
 * Generates an exact template-cloned QA Excel workbook (.xlsx) Buffer
 * preserving all 5 sheets (`ILUO Abstract (2)`, `Dept wise`, `Exp wise summary`,
 * `Sec wise Summary`, `Name list`), hidden-sheet states, merged headers, colors,
 * borders, column widths, and live formulas.
 */
async function exportQaWorkbookBuffer(employees = [], records = {}, ojtRecords = {}) {
  if (!fs.existsSync(QA_TEMPLATE_PATH)) {
    throw new Error('Base QA template not found at /public/templates/qa_template.xlsx');
  }

  const templateBuf = fs.readFileSync(QA_TEMPLATE_PATH);
  const { workbook, preservedCharts } = await loadExcelJsWorkbookSafely(templateBuf);

  const ws = workbook.getWorksheet('Name list');
  if (!ws) throw new Error('QA template missing "Name list" worksheet.');

  const maxCol = 12; // A..L
  const templateRow2Style = captureRowStyleTemplate(ws, 2, maxCol);
  const templateRow3Style = captureRowStyleTemplate(ws, 3, maxCol);
  const previousLastRow = Math.max(ws.rowCount, 2);

  // Preserve template row order and default assessment date from Row 2
  const templateOrder = [];
  let defaultAssessDate = '2026-06-30';
  const row2H = formatExcelDate(ws.getRow(2).getCell(8).value);
  if (row2H) defaultAssessDate = row2H;

  for (let r = 2; r <= ws.rowCount; r++) {
    const id = normalizeEmpNo(ws.getRow(r).getCell(2).value);
    if (id && !templateOrder.includes(id)) templateOrder.push(id);
  }
  const orderIdx = new Map(templateOrder.map((id, i) => [id, i]));

  const qaEmps = employees
    .filter(e => !e.isLeft && e.status !== 'LEFT' && isQaDepartment(e.dept))
    .sort((a, b) => {
      const ia = orderIdx.has(normalizeEmpNo(a.empNo)) ? orderIdx.get(normalizeEmpNo(a.empNo)) : 999999;
      const ib = orderIdx.has(normalizeEmpNo(b.empNo)) ? orderIdx.get(normalizeEmpNo(b.empNo)) : 999999;
      return ia - ib;
    });

  const makeExpBracketFormula = (r) =>
    `IF(H${r}="",\n   IF(I${r}="","",CHOOSE(MATCH(I${r}, {0,3,6,9,12,24,36,48,60,72,84,96,108,120}, 1),\n        "0-3 months",\n        "3-6 months",\n        "6-9 months",\n        "9-12 months",\n        "1-2 years",\n        "2-3 years",\n        "3-4 years",\n        "4-5 years",\n        "5-6 years",\n        "6-7 years",\n        "7-8 years",\n        "8-9 years",\n        "9-10 years",\n        "10+ years")),\n   IF(I${r}="","",CHOOSE(MATCH(I${r}, {0,3,6,9,12,24,36,48,60,72,84,96,108,120}, 1),\n        "0-3 months",\n        "3-6 months",\n        "6-9 months",\n        "9-12 months",\n        "1-2 years",\n        "2-3 years",\n        "3-4 years",\n        "4-5 years",\n        "5-6 years",\n        "6-7 years",\n        "7-8 years",\n        "8-9 years",\n        "9-10 years",\n        "10+ years")))`;

  qaEmps.forEach((emp, idx) => {
    const r = 2 + idx;
    const row = ws.getRow(r);
    const stylePack = idx === 0 ? templateRow2Style : templateRow3Style;
    if (stylePack.height) row.height = stylePack.height;

    for (let c = 1; c <= maxCol; c++) {
      if (stylePack.styles[c]) {
        row.getCell(c).style = cloneStyle(stylePack.styles[c]);
      }
    }

    const key = normalizeEmpNo(emp.empNo);
    const empNoCellVal = /^\d+$/.test(key) ? Number(key) : key;
    const dojStr = formatExcelDate(emp.doj);
    const assessStr = formatExcelDate(emp.assessmentDate) || defaultAssessDate;
    const dojObj = toExcelDateObject(dojStr);
    const assessObj = toExcelDateObject(assessStr);
    const expCalc = computeQaExperienceSkill(dojStr, assessStr);

    // Current Skill Level (L): prefer switched/updated currentLevel if assessed, else skillLevelAssess2025
    const rec = (records && (records[key] || records[emp.empNo])) || null;
    const latestLevel = normalizeLevel(
      (rec && rec.switchedLevel) ||
      emp.currentLevel ||
      emp.skillLevelAssess2025
    );

    // --- INPUT COLUMNS ONLY (B–H, L) ---
    row.getCell(2).value = empNoCellVal;                                           // B: EMP NO
    row.getCell(3).value = emp.name || '';                                         // C: NAME
    row.getCell(4).value = emp.dept || 'QUALITY CONTROL';                          // D: Dept
    row.getCell(5).value = emp.qaTemplateSection || emp.templateSection || emp.section || ''; // E: Existing Section Name
    row.getCell(6).value = emp.qualification || null;                              // F: Qualification
    row.getCell(7).value = dojObj || (dojStr || null);                             // G: DOJ
    row.getCell(8).value = assessObj || (assessStr || null);                       // H: Date of assesment
    row.getCell(12).value = latestLevel || null;                                   // L: Skill level as per Assessment 2025

    // --- LIVE FORMULA COLUMNS (A, I, J, K) ---
    row.getCell(1).value = r === 2 ? 1 : { formula: `A${r - 1}+1`, result: idx + 1 };
    row.getCell(9).value = {
      formula: `IF(H${r}="", DATEDIF(G${r}, TODAY(), "M"), DATEDIF(G${r}, H${r}, "M"))`,
      result: expCalc.expMonths !== null ? expCalc.expMonths : undefined
    };
    row.getCell(10).value = {
      formula: makeExpBracketFormula(r),
      result: expCalc.yearExp || undefined
    };
    row.getCell(11).value = {
      formula: `IFERROR(IF(DATEDIF(G${r},H${r},"M")>48,"O",IF(DATEDIF(G${r},H${r},"M")>24,"U",IF(DATEDIF(G${r},H${r},"M")>3,"L","I"))),"Not Eligible")`,
      result: expCalc.expSkillLevel
    };

    row.commit();
  });

  // Clear leftover rows if new QA dataset has fewer rows than the template
  const newLastRow = 1 + qaEmps.length;
  for (let r = newLastRow + 1; r <= previousLastRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      row.getCell(c).value = null;
    }
    row.commit();
  }

  return await writeExcelJsWorkbookSafely(workbook, preservedCharts);
}

module.exports = {
  PRODUCTION_TEMPLATE_PATH,
  QA_TEMPLATE_PATH,
  normalizeEmpNo,
  parseExcelNumberOrNull,
  formatExcelDate,
  toExcelDateObject,
  getKnowledgeMaxMarks,
  evaluateTemplatePassFail,
  oneLevelDown,
  computeProductionEvaluation,
  computeCompletedMonths,
  computeYearWiseExpBracket,
  computeQaExperienceSkill,
  loadExcelJsWorkbookSafely,
  writeExcelJsWorkbookSafely,
  detectWorkbookType,
  parseUploadedWorkbook,
  buildWorkbookSyncPlan,
  exportProductionWorkbookBuffer,
  exportQaWorkbookBuffer
};
