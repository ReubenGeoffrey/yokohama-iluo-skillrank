require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 5000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'yokohama_iluo_qa_secret_2026';
const AUTHORIZED_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com').toLowerCase();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname)));

// Explicit favicon handler (prevents 120KB HTML response)
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'yokohama_logo.png'));
});

// Explicit OJT Official Templates script handler
app.get('/ojt_templates_data.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'ojt_templates_data.js'));
});

// Server-side active OTP storage (Email -> { otp, expiresAt, attempts, lastSendAt })
const otpStore = new Map();

// Active authenticated admin sessions (SessionToken -> { email, name, role, createdAt })
const activeSessions = new Map();

// Configure Real Gmail SMTP Transporter — port 587 STARTTLS (confirmed working)
const user = (process.env.SMTP_USER || 'reubengeoffrey16@gmail.com').trim();
const pass = (process.env.SMTP_PASS || 'wydejmkbmbngbqwo').replace(/\s+/g, '').trim();

// Safe debug: confirm what credentials are loaded (NEVER logs actual password)
console.log(`📧 SMTP User: ${user}`);
console.log(`🔑 SMTP Pass loaded: ${pass.length > 0 ? `YES (${pass.length} chars)` : 'NO — SMTP_PASS is empty or missing in .env'}`);
console.log(`🔌 SMTP Host: smtp.gmail.com:587 | STARTTLS`);

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: user,
    pass: pass
  }
});

// Debug SMTP Connection on startup (local development only to eliminate serverless cold-start latency)
if (!process.env.VERCEL) {
  transporter.verify((error, success) => {
    if (error) {
      console.error(`SMTP connection failed: ${error.message}`);
    } else {
      console.log('SMTP connection successful');
    }
  });
}


// ---------------------------------------------------------------------
// Cloud-Persisted OTP & Session Helpers (Fixes Vercel Serverless Resets)
// ---------------------------------------------------------------------
async function setCloudOtp(email, record) {
  otpStore.set(email, record);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', `otp:${email}`, record);
  }
}

async function getCloudOtp(email) {
  if (kvUrl && kvToken) {
    const cloudRecord = await syncWithCloudKv('GET', `otp:${email}`);
    if (cloudRecord && cloudRecord.otp) {
      otpStore.set(email, cloudRecord);
      return cloudRecord;
    }
  }
  return otpStore.get(email) || null;
}

async function delCloudOtp(email) {
  otpStore.delete(email);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', `otp:${email}`, null);
  }
}

async function setCloudSession(token, sessionData) {
  activeSessions.set(token, sessionData);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', `sess:${token}`, sessionData);
  }
}

async function getCloudSession(token) {
  if (!token) return null;
  if (kvUrl && kvToken) {
    const cloudSess = await syncWithCloudKv('GET', `sess:${token}`);
    if (cloudSess && cloudSess.email) {
      activeSessions.set(token, cloudSess);
      return cloudSess;
    }
  }
  return activeSessions.get(token) || null;
}

// Middleware: Verify Authenticated Admin Session for /api/admin/*
async function requireAdminAuth(req, res, next) {
  const sessionToken = req.signedCookies.admin_session || req.cookies.admin_session;
  const sessionData = await getCloudSession(sessionToken);
  if (!sessionToken || !sessionData) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Admin session required' });
  }
  req.adminSession = sessionData;
  next();
}

// ---------------------------------------------------------------------
// API ROUTE 1: POST /api/auth/admin/send-otp
// ---------------------------------------------------------------------
app.post('/api/auth/admin/send-otp', async (req, res) => {
  const emailRaw = (req.body.email || '').trim().toLowerCase();

  if (!emailRaw || !emailRaw.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid Admin Email ID required' });
  }

  // Read custom authorized admin email from Cloud Settings if saved by admin
  let allowedEmails = [AUTHORIZED_ADMIN_EMAIL, 'reubengeoffrey16@gmail.com', 'admin@yokohama-oht.com'];
  let otpDurationSecs = 60;

  if (kvUrl && kvToken) {
    const cloudSettings = await syncWithCloudKv('GET', 'yokohama_settings');
    if (cloudSettings && cloudSettings.adminEmail) {
      allowedEmails.push(cloudSettings.adminEmail.toLowerCase().trim());
    }
    if (cloudSettings && cloudSettings.otpDuration) {
      otpDurationSecs = parseInt(cloudSettings.otpDuration) || 60;
    }
  }
  if (customSettingsMemory && customSettingsMemory.adminEmail) {
    allowedEmails.push(customSettingsMemory.adminEmail.toLowerCase().trim());
  }
  if (customSettingsMemory && customSettingsMemory.otpDuration) {
    otpDurationSecs = parseInt(customSettingsMemory.otpDuration) || 60;
  }

  // Support Outlook (@outlook.com, @hotmail.com, @live.com), ProtonMail, Gmail, and configured emails
  const isAllowedDomain = emailRaw.endsWith('@outlook.com') ||
                         emailRaw.endsWith('@hotmail.com') ||
                         emailRaw.endsWith('@live.com') ||
                         emailRaw.endsWith('@msn.com') ||
                         emailRaw.endsWith('@protonmail.com') ||
                         emailRaw.endsWith('@proton.me') ||
                         emailRaw.endsWith('@gmail.com') ||
                         emailRaw.endsWith('@yokohama-oht.com');

  // Allow match if in allowed list OR if it's a supported email provider
  if (!allowedEmails.includes(emailRaw) && !isAllowedDomain) {
    return res.status(403).json({ success: false, message: `Unauthorized admin email. Please use your authorized email or register it in Admin Security Settings.` });
  }

  // Rate Limiting: 30-second cooldown between send-otp requests
  const existingRecord = await getCloudOtp(emailRaw);
  const now = Date.now();
  if (existingRecord && (now - existingRecord.lastSendAt) < 30000) {
    const waitSecs = Math.ceil((30000 - (now - existingRecord.lastSendAt)) / 1000);
    return res.status(429).json({ success: false, message: `Please wait ${waitSecs} seconds before requesting a new OTP.` });
  }

  // Cryptographically secure 6-digit OTP generation using crypto.randomInt
  const otpNum = crypto.randomInt(100000, 1000000);
  const otp = String(otpNum);
  const expiresAt = now + (otpDurationSecs * 1000);

  const newOtpRecord = {
    otp: otp,
    expiresAt: expiresAt,
    attempts: 0,
    lastSendAt: now
  };

  await setCloudOtp(emailRaw, newOtpRecord);

  const mailOptions = {
    from: `"Yokohama ILUO Admin" <${user}>`,
    to: emailRaw,
    subject: `Yokohama ILUO Admin Login OTP`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; padding: 24px; border: 2px solid #005B9E; border-radius: 12px; background: #FFFFFF; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #005B9E 0%, #003D6B 100%); color: white; padding: 16px; border-radius: 8px; font-weight: 800; font-size: 18px; text-align: center; letter-spacing: 0.5px;">
          Yokohama ILUO Admin Login
        </div>
        <div style="padding: 24px 16px; text-align: center;">
          <p style="font-size: 16px; color: #334155; margin-bottom: 12px; font-weight: 600;">Your OTP is:</p>
          <div style="font-size: 38px; font-weight: 800; color: #005B9E; letter-spacing: 8px; background: #F0F9FF; border: 2px dashed #0284C7; padding: 16px 28px; border-radius: 10px; display: inline-block; margin: 12px 0 20px 0;">
            ${otp}
          </div>
          <p style="color: #E31B23; font-weight: 800; font-size: 15px; margin-top: 8px;">⏱️ Expires in 1 minute (60 seconds)</p>
        </div>
        <div style="border-top: 1px solid #E2E8F0; padding-top: 16px; font-size: 12px; color: #94A3B8; text-align: center;">
          Official Yokohama Off-Highway Tires Quality Assurance Portal
        </div>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('email send successful');
    return res.json({
      success: true,
      message: '✉️ OTP sent to your email inbox. Please check your Gmail and enter the 6-digit OTP.'
    });
  } catch (error) {
    console.error(`email send failed: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Failed to send email OTP via Gmail SMTP. Check server logs.',
      error: error.message
    });
  }
});

// ---------------------------------------------------------------------
// API ROUTE: POST /api/auth/admin/login (Testing Mode: Username & Password)
// ---------------------------------------------------------------------
app.post('/api/auth/admin/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (username === 'admin' && password === 'admin123') {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const adminName = 'Administrator';

    const sessionData = {
      email: 'admin@yokohama.com',
      name: adminName,
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString()
    };

    await setCloudSession(sessionToken, sessionData);

    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      signed: true
    });

    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      admin: {
        email: 'admin@yokohama.com',
        name: adminName,
        role: 'SUPERADMIN'
      }
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid credentials. Testing username: admin, password: admin123'
  });
});

// ---------------------------------------------------------------------
// API ROUTE 2: POST /api/auth/admin/verify-otp
// ---------------------------------------------------------------------
app.post('/api/auth/admin/verify-otp', async (req, res) => {
  const emailRaw = (req.body.email || '').trim().toLowerCase();
  const otpEntered = (req.body.otp || '').trim();

  if (!emailRaw || !otpEntered) {
    return res.status(400).json({ success: false, message: 'Email and OTP code required' });
  }

  const record = await getCloudOtp(emailRaw);
  if (!record) {
    return res.status(400).json({ success: false, message: 'No active OTP request found for this email. Please click Send OTP.' });
  }

  // Maximum 5 verification attempts to prevent brute-force attacks
  record.attempts = (record.attempts || 0) + 1;
  if (record.attempts > 5) {
    await delCloudOtp(emailRaw);
    return res.status(429).json({ success: false, message: 'Maximum failed verification attempts reached (5/5). OTP invalidated. Please request a new OTP.' });
  }

  // Check 60-second (1-minute) expiry limit
  const now = Date.now();
  if (now > record.expiresAt) {
    await delCloudOtp(emailRaw);
    return res.status(400).json({ success: false, message: 'OTP Expired! (1-minute validity window passed). Please request a new OTP.' });
  }

  // Strict Single-Use OTP Match
  if (record.otp === otpEntered) {
    await delCloudOtp(emailRaw); // Single-use consumption & deletion

    // Create secure session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const adminName = emailRaw === AUTHORIZED_ADMIN_EMAIL ? 'Reuben Geoffrey (Superadmin)' : 'Administrator';

    const sessionData = {
      email: emailRaw,
      name: adminName,
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString()
    };

    await setCloudSession(sessionToken, sessionData);

    // Set HTTP-Only Cookie
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours session duration
      signed: true
    });

    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      admin: {
        email: emailRaw,
        name: adminName,
        role: 'SUPERADMIN'
      }
    });
  } else {
    await setCloudOtp(emailRaw, record);
    return res.status(400).json({
      success: false,
      message: `Incorrect OTP code (${record.attempts}/5 attempts)`
    });
  }
});

// ---------------------------------------------------------------------
// API ROUTE 3: GET /api/auth/admin/session
// ---------------------------------------------------------------------
app.get('/api/auth/admin/session', async (req, res) => {
  const sessionToken = req.signedCookies.admin_session || req.cookies.admin_session;
  const sessionData = await getCloudSession(sessionToken);
  if (sessionToken && sessionData) {
    return res.json({
      success: true,
      authenticated: true,
      admin: sessionData
    });
  } else {
    return res.json({
      success: true,
      authenticated: false,
      admin: null
    });
  }
});

// ---------------------------------------------------------------------
// API ROUTE 4: POST /api/auth/admin/logout
// ---------------------------------------------------------------------
app.post('/api/auth/admin/logout', (req, res) => {
  const sessionToken = req.signedCookies.admin_session || req.cookies.admin_session;
  if (sessionToken) {
    activeSessions.delete(sessionToken);
  }
  res.clearCookie('admin_session');
  return res.json({ success: true, message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------
// CLOUD RECORD PERSISTENCE ENGINE (Multi-Device Global Sync & Disk Backup)
// ---------------------------------------------------------------------
const fs = require('fs');
const { execFile } = require('child_process');
const RECORDS_JSON_FILE = path.join(__dirname, 'assessment_records.json');
const globalAssessmentRecords = new Map();

try {
  if (fs.existsSync(RECORDS_JSON_FILE)) {
    const raw = fs.readFileSync(RECORDS_JSON_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    Object.entries(parsed).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
    console.log(`📋 Loaded ${globalAssessmentRecords.size} assessment records from disk.`);
  }
} catch (e) {
  console.error('Error loading assessment records from disk:', e.message);
}

const kvUrl = process.env.UPSTASH_REDIS_REST_URL;
const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function syncWithCloudKv(action, key = 'yokohama_records', value = null) {
  if (!kvUrl || !kvToken) return null;
  try {
    if (action === 'GET') {
      const resp = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const data = await resp.json();
      if (data && data.result) {
        return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
      }
      return {};
    } else if (action === 'SET') {
      const valStr = JSON.stringify(value);
      const resp = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', key, valStr])
      });
      const resData = await resp.json();
      console.log('☁️ Upstash Cloud KV Save Status:', resData);
    }
  } catch (err) {
    console.error('Cloud KV sync error:', err.message);
  }
  return null;
}

// API ROUTE: GET /api/records (Fetch all exam records across devices)
app.get('/api/records', async (req, res) => {
  let recordsObj = Object.fromEntries(globalAssessmentRecords);

  if (kvUrl && kvToken) {
    const cloudRecords = await syncWithCloudKv('GET');
    if (cloudRecords && typeof cloudRecords === 'object') {
      recordsObj = { ...cloudRecords, ...recordsObj };
      Object.entries(recordsObj).forEach(([k, v]) => globalAssessmentRecords.set(k, v));
    }
  }

  res.json({ success: true, records: recordsObj });
});

// API ROUTE: POST /api/records (Save / Update employee assessment result)
app.post('/api/records', async (req, res) => {
  const { empNo, recordData } = req.body;
  if (!empNo || !recordData) {
    return res.status(400).json({ success: false, message: 'empNo and recordData required' });
  }

  const existing = globalAssessmentRecords.get(String(empNo)) || {};
  const updated = { ...existing, ...recordData };
  globalAssessmentRecords.set(String(empNo), updated);

  const recordsObj = Object.fromEntries(globalAssessmentRecords);
  try {
    fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(recordsObj, null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal on read-only environments
  }

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_records', recordsObj);
  }

  res.json({ success: true, message: `Record saved for employee ${empNo}`, record: updated });
});

// API ROUTE: DELETE /api/records/:empNo (Reset specific employee exam)
app.delete('/api/records/:empNo', async (req, res) => {
  const { empNo } = req.params;
  if (globalAssessmentRecords.has(String(empNo))) {
    globalAssessmentRecords.delete(String(empNo));
    const recordsObj = Object.fromEntries(globalAssessmentRecords);
    try {
      fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(recordsObj, null, 2), 'utf-8');
    } catch (err) {
      // Non-fatal on read-only environments
    }
    if (kvUrl && kvToken) {
      await syncWithCloudKv('SET', 'yokohama_records', recordsObj);
    }
  }
  res.json({ success: true, message: `Record reset for employee ${empNo}` });
});

// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// INDIVIDUAL EMPLOYEE DOCX QUALIFICATION REPORT GENERATOR (Exact Template Mapper)
// ---------------------------------------------------------------------
const { getTemplateFilename, mapExactTemplate, generateStandaloneOjtDocx } = require('./docx_generator.js');
let JSZipLib = null;
try {
  JSZipLib = require('./jszip.min.js');
} catch (e) {
  try { JSZipLib = require('jszip'); } catch (err) {}
}

let serverOjtTemplates = null;
try {
  const ojtCode = fs.readFileSync(path.join(__dirname, 'ojt_templates_data.js'), 'utf-8');
  const vm = require('vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(ojtCode, sandbox);
  serverOjtTemplates = sandbox.OJT_OFFICIAL_TEMPLATES || null;
} catch (e) {}

async function buildDocxBufferForEmployee(empNo, optionalRecordData) {
  let emp = null;
  if (customEmployeesMemory && Array.isArray(customEmployeesMemory)) {
    emp = customEmployeesMemory.find(e => String(e.empNo).trim() === String(empNo).trim());
  }
  if (!emp && fs.existsSync(EMPLOYEES_JSON_FILE)) {
    try {
      const emps = JSON.parse(fs.readFileSync(EMPLOYEES_JSON_FILE, 'utf-8'));
      emp = emps.find(e => String(e.empNo).trim() === String(empNo).trim());
    } catch (e) {}
  }
  if (!emp) {
    emp = {
      empNo: empNo,
      name: `Employee ${empNo}`,
      dept: 'QUALITY CONTROL',
      section: 'Tire building QA',
      doj: '-',
      targetLevel: 'O'
    };
  }

  const examRecord = optionalRecordData || globalAssessmentRecords.get(String(empNo)) || null;
  const targetLevel = (examRecord && examRecord.targetLevel) || emp.targetLevel || emp.currentLevel || 'O';
  const templateFilename = getTemplateFilename(targetLevel, emp.section);

  // Look for template in QC_templates or D:\QC question or QC question
  let templatePath = path.join(__dirname, 'QC_templates', templateFilename);
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join('D:', 'QC question', templateFilename);
  }
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join(__dirname, 'QC question', templateFilename);
  }

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found for ${targetLevel} ${emp.section}: ${templateFilename}`);
  }

  const templateBuf = fs.readFileSync(templatePath);

  // Load question bank questions for this level to map answer keys if candidate hasn't taken exam
  let qbQuestions = [];
  if (customQuestionBankMemory && customQuestionBankMemory[targetLevel]) {
    qbQuestions = customQuestionBankMemory[targetLevel];
  } else if (fs.existsSync(QUESTIONS_JSON_FILE)) {
    try {
      const qb = JSON.parse(fs.readFileSync(QUESTIONS_JSON_FILE, 'utf-8'));
      qbQuestions = qb[targetLevel] || [];
    } catch (e) {}
  }

  const ojtRec = globalOjtEvaluations ? globalOjtEvaluations.get(String(empNo)) : null;
  let ojtTmpl = null;
  if (serverOjtTemplates && emp && emp.section) {
    const s = emp.section.toLowerCase();
    if (s.includes('solid')) ojtTmpl = serverOjtTemplates['86D'];
    else if (s.includes('rro') || s.includes('alt')) ojtTmpl = serverOjtTemplates['83D'];
    else if (s.includes('preparatory')) ojtTmpl = serverOjtTemplates['85D'];
    else if (s.includes('building') || s.includes('tbm')) ojtTmpl = serverOjtTemplates['87D'];
    else if (s.includes('curing')) ojtTmpl = serverOjtTemplates['88D'];
    else if (s.includes('warehouse') || s.includes('data entry')) ojtTmpl = serverOjtTemplates['89D'];
    else if (s.includes('fid')) ojtTmpl = serverOjtTemplates['90D'];
    else if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) ojtTmpl = serverOjtTemplates['90G'];
    else ojtTmpl = serverOjtTemplates['84D'];
  }

  const zip = await mapExactTemplate(templateBuf, emp, examRecord, JSZipLib, qbQuestions, ojtRec, ojtTmpl);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

app.get('/api/employee-docx/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  try {
    const docxBuf = await buildDocxBufferForEmployee(empNo);
    const fileName = `Yokohama_ILUO_Report_${empNo}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', docxBuf.length);
    return res.send(docxBuf);
  } catch (err) {
    console.error(`DOCX generation error for ${empNo}:`, err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate DOCX', error: err.message });
  }
});

app.get('/api/ojt-docx/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  try {
    let emp = null;
    if (customEmployeesMemory && Array.isArray(customEmployeesMemory)) {
      emp = customEmployeesMemory.find(e => String(e.empNo).trim() === empNo);
    }
    if (!emp) emp = { empNo, name: `Employee ${empNo}`, section: 'Tire building QA', dept: 'QUALITY CONTROL' };

    const ojtRec = globalOjtEvaluations ? globalOjtEvaluations.get(empNo) : null;
    let ojtTmpl = null;
    if (serverOjtTemplates && emp && emp.section) {
      const s = emp.section.toLowerCase();
      if (s.includes('solid')) ojtTmpl = serverOjtTemplates['86D'];
      else if (s.includes('rro') || s.includes('alt')) ojtTmpl = serverOjtTemplates['83D'];
      else if (s.includes('preparatory')) ojtTmpl = serverOjtTemplates['85D'];
      else if (s.includes('building') || s.includes('tbm')) ojtTmpl = serverOjtTemplates['87D'];
      else if (s.includes('curing')) ojtTmpl = serverOjtTemplates['88D'];
      else if (s.includes('warehouse') || s.includes('data entry')) ojtTmpl = serverOjtTemplates['89D'];
      else if (s.includes('fid')) ojtTmpl = serverOjtTemplates['90D'];
      else if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) ojtTmpl = serverOjtTemplates['90G'];
      else ojtTmpl = serverOjtTemplates['84D'];
    }
    if (!ojtTmpl && serverOjtTemplates) ojtTmpl = serverOjtTemplates['87D'] || Object.values(serverOjtTemplates)[0];

    const zip = await generateStandaloneOjtDocx(emp, ojtTmpl, (ojtRec && ojtRec.scores) || {}, (ojtRec && ojtRec.wiChecks) || {}, ojtRec || {}, JSZipLib);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const cleanName = (emp.name || empNo).replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `Yokohama_OJT_${ojtTmpl ? ojtTmpl.id : 'Form'}_${empNo}_${cleanName}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);
  } catch (err) {
    console.error(`OJT DOCX error for ${empNo}:`, err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate OJT DOCX', error: err.message });
  }
});

app.post('/api/generate-docx', async (req, res) => {
  const { empNo, recordData } = req.body;
  if (!empNo) {
    return res.status(400).json({ success: false, message: 'empNo is required' });
  }

  const strEmpNo = String(empNo).trim();
  if (recordData) {
    globalAssessmentRecords.set(strEmpNo, recordData);
    try {
      fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(Object.fromEntries(globalAssessmentRecords), null, 2), 'utf-8');
    } catch (e) {}
  }

  try {
    const docxBuf = await buildDocxBufferForEmployee(strEmpNo, recordData);
    const fileName = `Yokohama_ILUO_Report_${strEmpNo}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', docxBuf.length);
    return res.send(docxBuf);
  } catch (err) {
    console.error(`DOCX generation error for ${empNo}:`, err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate DOCX', error: err.message });
  }
});

// ---------------------------------------------------------------------
// ON-THE-JOB TRAINING EVALUATION (OJT) CLOUD & EXCEL PERSISTENCE
// ---------------------------------------------------------------------
const OJT_JSON_FILE = path.join(__dirname, 'ojt_evaluations.json');
const globalOjtEvaluations = new Map();

try {
  if (fs.existsSync(OJT_JSON_FILE)) {
    const raw = fs.readFileSync(OJT_JSON_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    Object.entries(parsed).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
    console.log(`📋 Loaded ${globalOjtEvaluations.size} OJT evaluations from disk.`);
  }
} catch (e) {
  console.error('Error loading OJT evaluations:', e.message);
}

app.get('/api/ojt-evaluations', async (req, res) => {
  let ojtObj = Object.fromEntries(globalOjtEvaluations);

  if (kvUrl && kvToken) {
    const cloudOjt = await syncWithCloudKv('GET', 'yokohama_ojt_evaluations');
    if (cloudOjt && typeof cloudOjt === 'object') {
      ojtObj = { ...cloudOjt, ...ojtObj };
      Object.entries(ojtObj).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
    }
  }

  res.json({ success: true, evaluations: ojtObj });
});

app.post('/api/ojt-evaluations', async (req, res) => {
  const { empNo, ojtData } = req.body;
  if (!empNo || !ojtData) {
    return res.status(400).json({ success: false, message: 'empNo and ojtData required' });
  }

  globalOjtEvaluations.set(String(empNo), ojtData);

  try {
    fs.writeFileSync(OJT_JSON_FILE, JSON.stringify(Object.fromEntries(globalOjtEvaluations), null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal on read-only environments like Vercel serverless
  }

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_ojt_evaluations', Object.fromEntries(globalOjtEvaluations));
  }

  try {
    const scriptPath = path.join(__dirname, 'update_ojt_excel.py');
    if (fs.existsSync(scriptPath)) {
      execFile('python', [scriptPath, '--emp', String(empNo)], (err, stdout, stderr) => {
        if (err) {
          console.error(`Error updating Excel for employee ${empNo}:`, err.message);
        } else {
          console.log(`Excel updated for employee ${empNo}: ${stdout.trim()}`);
        }
      });
    }
  } catch (err) {
    // Non-fatal if python/excel not available on cloud serverless
  }

  res.json({ success: true, message: `OJT evaluation saved and synced for employee ${empNo}` });
});

// ---------------------------------------------------------------------
// QUESTION BANK CLOUD & DISK PERSISTENCE ENGINE (Permanent Admin Edits)
// ---------------------------------------------------------------------
const QUESTIONS_JSON_FILE = path.join(__dirname, 'custom_questions.json');
let customQuestionBankMemory = null;

try {
  if (fs.existsSync(QUESTIONS_JSON_FILE)) {
    const raw = fs.readFileSync(QUESTIONS_JSON_FILE, 'utf-8');
    customQuestionBankMemory = JSON.parse(raw);
    console.log(`📋 Loaded custom question bank from disk.`);
  }
} catch (e) {
  console.error('Error loading custom questions from disk:', e.message);
}

// API ROUTE: GET /api/questions (Fetch custom question bank edits)
app.get('/api/questions', async (req, res) => {
  if (kvUrl && kvToken) {
    const cloudQuestions = await syncWithCloudKv('GET', 'yokohama_question_bank');
    if (cloudQuestions && typeof cloudQuestions === 'object' && Object.keys(cloudQuestions).length > 0) {
      customQuestionBankMemory = cloudQuestions;
    }
  }

  res.json({
    success: true,
    questionBank: customQuestionBankMemory
  });
});

// API ROUTE: POST /api/questions (Save custom question bank edits permanently)
app.post('/api/questions', async (req, res) => {
  const { questionBank } = req.body;
  if (!questionBank) {
    return res.status(400).json({ success: false, message: 'questionBank object required' });
  }

  customQuestionBankMemory = questionBank;

  try {
    fs.writeFileSync(QUESTIONS_JSON_FILE, JSON.stringify(questionBank, null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal on read-only environments
  }

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_question_bank', questionBank);
  }

  res.json({ success: true, message: 'Question Bank updated and synced permanently!' });
});

// ---------------------------------------------------------------------
// EMPLOYEE DIRECTORY CLOUD & DISK PERSISTENCE ENGINE (Add, Edit, Delete)
// ---------------------------------------------------------------------
const EMPLOYEES_JSON_FILE = path.join(__dirname, 'custom_employees.json');
let customEmployeesMemory = null;

try {
  if (fs.existsSync(EMPLOYEES_JSON_FILE)) {
    const raw = fs.readFileSync(EMPLOYEES_JSON_FILE, 'utf-8');
    customEmployeesMemory = JSON.parse(raw);
    console.log(`📋 Loaded ${customEmployeesMemory.length} custom employees from disk.`);
  }
} catch (e) {
  console.error('Error loading custom employees from disk:', e.message);
}

app.get('/api/employees', async (req, res) => {
  if (kvUrl && kvToken) {
    const cloudEmployees = await syncWithCloudKv('GET', 'yokohama_employees');
    if (cloudEmployees && Array.isArray(cloudEmployees) && cloudEmployees.length > 0) {
      customEmployeesMemory = cloudEmployees;
    }
  }
  res.json({ success: true, employees: customEmployeesMemory });
});

app.post('/api/employees', async (req, res) => {
  const { employees } = req.body;
  if (!employees || !Array.isArray(employees)) {
    return res.status(400).json({ success: false, message: 'Array of employees required' });
  }
  customEmployeesMemory = employees;

  try {
    fs.writeFileSync(EMPLOYEES_JSON_FILE, JSON.stringify(employees, null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal on read-only environments
  }

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_employees', employees);
  }
  res.json({ success: true, message: 'Employee directory updated and persisted!' });
});

// ---------------------------------------------------------------------
// CUSTOM SECURITY SETTINGS ENGINE
// ---------------------------------------------------------------------
let customSettingsMemory = null;

app.get('/api/settings', async (req, res) => {
  if (kvUrl && kvToken) {
    const cloudSettings = await syncWithCloudKv('GET', 'yokohama_settings');
    if (cloudSettings && typeof cloudSettings === 'object' && Object.keys(cloudSettings).length > 0) {
      customSettingsMemory = cloudSettings;
    }
  }
  res.json({ success: true, settings: customSettingsMemory });
});

app.post('/api/settings', async (req, res) => {
  const { settings } = req.body;
  if (!settings) {
    return res.status(400).json({ success: false, message: 'settings object required' });
  }
  customSettingsMemory = settings;
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_settings', settings);
  }
  res.json({ success: true, message: 'Security settings saved to Cloud DB' });
});

// Protected Admin API Example Endpoint
app.get('/api/admin/dashboard-stats', requireAdminAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      totalEmployees: 236,
      admin: req.adminSession
    }
  });
});

// Fallback route to index.html for Client-Side Routing (only for SPA page navigation, never static assets or APIs)
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|json|map|docx|xlsx|pdf|txt|woff2?|ttf|eot)$/i)) {
    return res.status(404).json({ success: false, error: 'Not Found', path: req.path });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Yokohama Admin Portal running at http://localhost:${PORT}`);
  });
}

module.exports = app;
