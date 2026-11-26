(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ILUO_CONSTANTS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEPARTMENTS = [
    { value: 'PRODUCTION', label: 'PRODUCTION', icon: '🏭' },
    { value: 'QUALITY CONTROL', label: 'QUALITY CONTROL', icon: '🔬' },
    { value: 'SAFETY', label: 'SAFETY', icon: '🦺' },
    { value: 'CI & TPM', label: 'CI & TPM', icon: '⚙️' },
    { value: 'TECHNICAL', label: 'TECHNICAL', icon: '🔧' },
    { value: 'HR', label: 'HR', icon: '👥' },
  ];

  const QA_SECTIONS = [
    { id: 'tire_building', name: 'Tire Building QA', code: 'TB', templateCode: '87D' },
    { id: 'final_finish', name: 'Final Finish QA', code: 'FF', templateCode: '84D' },
    { id: 'rro_alt', name: 'Final Finish RRO & ALT QA', code: 'RA', templateCode: '83D' },
    { id: 'tire_curing', name: 'Tire Curing QA', code: 'TC', templateCode: '88D' },
    { id: 'solid_tire', name: 'Solid Tire QA', code: 'ST', templateCode: '86D' },
    { id: 'preparatory', name: 'Preparatory QA', code: 'PR', templateCode: '85D' },
    { id: 'warehouse', name: 'Warehouse QA', code: 'WH', templateCode: '89D' },
    { id: 'fid_inspector', name: 'FID Inspector QA', code: 'FD', templateCode: '90D' },
  ];

  const PRODUCTION_SECTIONS = [
    'MIXING',
    'TYRE CURING',
    'SOLID TYRE',
    'EXTRUDER',
    'STEELASTIC',
    '3 ROLL-P2',
    '4 ROLL',
    'LINER DRESSING',
    'BEAD WINDING',
    'TYRE BUILDING-P1',
    'BAND BUILDING-P1',
    'BIAS CUTTING-2',
    'RADIAL MARANGONI',
    'SLITTING',
    'TYRE BUILDING-P2',
    'BAND BUILDING-P2',
    'BIAS CUTTING-1',
    'BIAS CUTTING-4',
    'BIAS MARANGONI&BESTRY',
    'TYRE BUILDING-P3',
    'BAND BUILDING-P3',
    'BIAS CUTTING-5',
    'YANTHAI',
    'AUTO BIASCUTTER',
    'SALVAGE',
  ];

  const QUESTION_CATEGORIES = ['Safety', 'CI & TPM', 'Quality', 'Process'];

  const ILUO_LEVELS = {
    I: {
      code: 'I',
      title: 'Beginner',
      description: 'Induction & Basic Safety (0 - 6 Days)',
      nextLevel: 'L',
      color: '#64748B',
      bg: '#F1F5F9',
      textColor: '#334155',
      questions: 20,
      eligibleDaysMin: 0,
    },
    L: {
      code: 'L',
      title: 'Learner',
      description: 'Learning under Supervision (7 - 90 Days)',
      nextLevel: 'U',
      color: '#F59E0B',
      bg: '#FFFBEB',
      textColor: '#B45309',
      questions: 20,
      eligibleDaysMin: 7,
    },
    U: {
      code: 'U',
      title: 'Executor',
      description: 'Independent Standard Execution (3M - 2 Years)',
      nextLevel: 'O',
      color: '#005B9E',
      bg: '#EFF6FF',
      textColor: '#1D4ED8',
      questions: 30,
      eligibleDaysMin: 91,
    },
    O: {
      code: 'O',
      title: 'Expert',
      description: 'Master Trainer & Auditor (> 4 Years)',
      nextLevel: 'O',
      color: '#10B981',
      bg: '#ECFDF5',
      textColor: '#047857',
      questions: 40,
      eligibleDaysMin: 1460,
    },
  };

  const DEFAULT_SETTINGS = {
    examPassingPct: 50,
    ojtPassingPct: 70,
    examDurationMinutes: 45,
    maxTabSwitches: 3,
    tabSwitchAction: 'terminate',
    adminEmail: '',
  };

  function normalizeQaSectionKey(sec) {
    let s = String(sec || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace('ware house', 'warehouse')
      .replace('tyre', 'tire');
    if (s.includes('rro') || s.includes('alt') || s === 'rro_alt') return 'final finish rro & alt qa';
    if (s.includes('building') || s.includes('tbm') || s === 'tire_building') return 'tire building qa';
    if (s.includes('curing') || s === 'tire_curing') return 'tire curing qa';
    if (s.includes('solid') || s === 'solid_tire') return 'solid tire qa';
    if (s.includes('preparatory') || s === 'preparatory') return 'preparatory qa';
    if (s.includes('fid') || s === 'fid_inspector') return 'fid inspector qa';
    if (s.includes('warehouse') || s.includes('data entry') || s === 'warehouse') return 'warehouse qa';
    if (s.includes('finish') || s === 'final_finish') return 'final finish qa';
    return s;
  }

  function canonicalQaSectionName(sec) {
    const norm = normalizeQaSectionKey(sec);
    const match = QA_SECTIONS.find((s) => s.name.toLowerCase() === norm || s.id === sec);
    return match ? match.name : String(sec || '').trim();
  }

  function normalizeDepartmentName(dept) {
    const raw = String(dept || '').trim().toUpperCase();
    if (!raw || raw === 'QC' || raw.includes('QUALITY')) return 'QUALITY CONTROL';
    if (raw.includes('PROD')) return 'PRODUCTION';
    if (raw.includes('SAFE')) return 'SAFETY';
    if (raw.includes('CI') || raw.includes('TPM')) return 'CI & TPM';
    if (raw.includes('TECH')) return 'TECHNICAL';
    if (raw === 'HR' || raw.includes('HUMAN')) return 'HR';
    return raw;
  }

  function parseDojDate(dojStr) {
    if (!dojStr) return null;
    const s = String(dojStr).trim();
    if (!s || s === '-') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s + 'T00:00:00Z');
      return isNaN(d.getTime()) ? null : d;
    }
    const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (dmy) {
      let y = parseInt(dmy[3], 10);
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      const m = parseInt(dmy[2], 10) - 1;
      const d = parseInt(dmy[1], 10);
      const dt = new Date(Date.UTC(y, m, d));
      return isNaN(dt.getTime()) ? null : dt;
    }
    const parsed = new Date(s);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function calculateDojEligibility(dojStr, currentLevel) {
    const dt = parseDojDate(dojStr);
    if (!dt) return { days: null, eligibleLevel: currentLevel || 'L', isDueForUpgrade: false, label: 'DOJ Unknown' };
    const days = Math.max(0, Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24)));
    let eligibleLevel = 'I';
    if (days >= 1460) eligibleLevel = 'O';
    else if (days >= 91) eligibleLevel = 'U';
    else if (days >= 7) eligibleLevel = 'L';

    const order = { I: 0, L: 1, U: 2, O: 3 };
    const cur = String(currentLevel || 'I').toUpperCase();
    const isDueForUpgrade = (order[eligibleLevel] || 0) > (order[cur] || 0);
    return {
      days,
      years: Number((days / 365.25).toFixed(1)),
      eligibleLevel,
      isDueForUpgrade,
      label: isDueForUpgrade ? `Eligible for Level ${eligibleLevel} (${days}d)` : `On Track (Level ${cur})`,
    };
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    DEPARTMENTS,
    QA_SECTIONS,
    PRODUCTION_SECTIONS,
    QUESTION_CATEGORIES,
    ILUO_LEVELS,
    DEFAULT_SETTINGS,
    normalizeQaSectionKey,
    canonicalQaSectionName,
    normalizeDepartmentName,
    parseDojDate,
    calculateDojEligibility,
    escapeHtml,
  };
});
