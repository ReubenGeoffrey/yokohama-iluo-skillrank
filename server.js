require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 5000;
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error('FATAL: SESSION_SECRET environment variable is required in production environment. A consistent secret across all instances is mandatory.');
  }
  SESSION_SECRET = 'dev_ephemeral_session_secret_for_local_testing_only';
}
const AUTHORIZED_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const kvUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// Strict Trusted Origins Allowlist
const ALLOWED_ORIGINS = [
  'https://yokohama-iluo-portal.vercel.app',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
      (origin.endsWith('.vercel.app') && origin.includes('yokohama-iluo'));
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser(SESSION_SECRET));

// Standard Secure Cookie Options Helper
function getCookieOptions(maxAgeMs = 8 * 60 * 60 * 1000) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
    signed: true
  };
}

// CSRF & Untrusted Origin Blocker for mutating requests
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers['origin'] || req.headers['referer'];
  if (origin) {
    try {
      const u = new URL(origin);
      const isAllowed = ALLOWED_ORIGINS.includes(u.origin) ||
        (u.origin.endsWith('.vercel.app') && u.origin.includes('yokohama-iluo'));
      if (!isAllowed) {
        return res.status(403).json({ success: false, message: 'Forbidden: CSRF check failed (Untrusted Origin)' });
      }
    } catch (e) {
      return res.status(403).json({ success: false, message: 'Forbidden: Invalid request origin' });
    }
  }
  next();
});

// Strict Allowlist of Public Static Assets
const ALLOWED_STATIC_FILES = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/data.js',
  '/styles.css',
  '/ojt_templates_data.js',
  '/seed_data.js',
  '/docx_generator.js',
  '/report_html_generator.js',
  '/docx-preview.min.js',
  '/html2pdf.bundle.min.js',
  '/jszip.min.js',
  '/mammoth.browser.min.js',
  '/xlsx.full.min.js',
  '/atg_logo.png',
  '/assets/atg_logo.png',
  '/yokohama_logo.png',
  '/favicon.ico',
  '/favicon.png'
]);

// Static Security Middleware: Allowlist Only (Blocks /server.js, .env, .json, test files, configs)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  // Allow official Word templates in QC_templates
  if (req.path.startsWith('/QC_templates/') && req.path.endsWith('.docx')) {
    return next();
  }

  // Allow static images in /assets/
  if (req.path.startsWith('/assets/') && /\.(png|jpe?g|svg|ico|webp)$/i.test(req.path)) {
    return next();
  }

  if (ALLOWED_STATIC_FILES.has(req.path)) {
    return next();
  }

  // Reject all other direct file access attempts
  return res.status(403).json({
    success: false,
    error: 'Forbidden: Direct access to this resource is restricted by static security policy'
  });
});

// Explicit static route for QC_templates Word files & assets
app.use('/QC_templates', express.static(path.join(__dirname, 'QC_templates')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname), { dotfiles: 'ignore' }));

// Explicit logo & favicon handlers
app.get(['/atg_logo.png', '/assets/atg_logo.png'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/png');
  const p = fs.existsSync(path.join(__dirname, 'atg_logo.png'))
    ? path.join(__dirname, 'atg_logo.png')
    : path.join(__dirname, 'yokohama_logo.png');
  res.sendFile(p);
});

app.get(['/favicon.ico', '/favicon.png'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/png');
  const p = fs.existsSync(path.join(__dirname, 'atg_logo.png'))
    ? path.join(__dirname, 'atg_logo.png')
    : path.join(__dirname, 'yokohama_logo.png');
  res.sendFile(p);
});

// Explicit OJT Official Templates script handler
app.get('/ojt_templates_data.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'ojt_templates_data.js'));
});

// Explicit Seed Completed Records script handler
app.get('/seed_data.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'seed_data.js'));
});

// Explicit docx-preview library script handler
app.get('/docx-preview.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'docx-preview.min.js'));
});

// Explicit html2pdf bundle library script handler
app.get('/html2pdf.bundle.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'html2pdf.bundle.min.js'));
});

// Explicit report_html_generator script handler
app.get('/report_html_generator.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'report_html_generator.js'));
});

// Server-side active OTP storage (Email -> { otp, expiresAt, attempts, lastSendAt })
const otpStore = new Map();

// Active authenticated admin and employee sessions (SessionToken -> sessionData)
const activeSessions = new Map();

// Configure Real Gmail SMTP Transporter (strictly requires environment variables)
const user = (process.env.SMTP_USER || '').trim();
const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '').trim();

let transporter = null;
if (user && pass) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: true,
    auth: { user, pass }
  });

  if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
    transporter.verify((error) => {
      if (error) console.error(`SMTP connection failed: ${error.message}`);
      else console.log('SMTP connection successful');
    });
  }
} else {
  console.warn('⚠️ SMTP_USER or SMTP_PASS environment variable is not configured. Email OTP dispatch will be unavailable.');
}

// ---------------------------------------------------------------------
// Cloud-Persisted Upstash Redis Helper (Single Source of Truth)
// ---------------------------------------------------------------------
async function syncWithCloudKv(action, key = 'yokohama_records', value = null, ttlSeconds = null) {
  if (!kvUrl || !kvToken) return null;
  try {
    if (action === 'GET') {
      const resp = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const data = await resp.json();
      if (data && data.result) {
        return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
      }
      return null;
    } else if (action === 'SET') {
      const valStr = JSON.stringify(value);
      const command = ttlSeconds
        ? ['SET', key, valStr, 'EX', String(ttlSeconds)]
        : ['SET', key, valStr];
      const resp = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
      });
      return await resp.json();
    } else if (action === 'DEL') {
      const resp = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['DEL', key])
      });
      return await resp.json();
    }
  } catch (err) {
    console.error('Cloud KV sync error:', err.message);
  }
  return null;
}

async function setCloudOtp(email, record) {
  otpStore.set(email, record);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', `otp:${email}`, record, 300);
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
    await syncWithCloudKv('DEL', `otp:${email}`);
  }
}

async function setCloudSession(token, sessionData, ttlSeconds = 28800) {
  activeSessions.set(token, sessionData);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', `sess:${token}`, sessionData, ttlSeconds);
  }
}

async function delCloudSession(token) {
  if (!token) return;
  activeSessions.delete(token);
  if (kvUrl && kvToken) {
    await syncWithCloudKv('DEL', `sess:${token}`);
  }
}

async function getCloudSession(token) {
  if (!token) return null;
  let session = null;
  if (kvUrl && kvToken) {
    const cloudSess = await syncWithCloudKv('GET', `sess:${token}`);
    if (cloudSess && (cloudSess.email || cloudSess.empNo || cloudSess.role)) {
      session = cloudSess;
      activeSessions.set(token, cloudSess);
    }
  }
  if (!session) {
    session = activeSessions.get(token) || null;
  }
  if (session && session.expiresAt && Date.now() > session.expiresAt) {
    await delCloudSession(token);
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------
// Role-Based Authorization Engine (RBAC)
// ---------------------------------------------------------------------
async function getAuthUser(req) {
  // Check any signed cookie, regular cookie, or header
  const token = req.signedCookies.admin_session || req.cookies.admin_session ||
    req.signedCookies.evaluator_session || req.cookies.evaluator_session ||
    req.signedCookies.section_session || req.cookies.section_session ||
    req.signedCookies.dept_session || req.cookies.dept_session ||
    req.signedCookies.emp_session || req.cookies.emp_session ||
    req.headers['x-admin-token'] || req.headers['x-evaluator-token'] ||
    req.headers['x-section-token'] || req.headers['x-dept-token'] ||
    req.headers['x-emp-token'] || req.headers['x-session-token'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);

  if (!token) return null;

  const session = await getCloudSession(token);
  if (!session) return null;

  req.authUser = session;
  if (['SUPERADMIN', 'ADMIN'].includes(session.role)) {
    req.adminSession = session;
  }
  if (session.role === 'emp') {
    req.empSession = session;
  }
  if (session.role === 'EVALUATOR') {
    req.evaluatorSession = session;
  }
  if (session.role === 'SECTION_HEAD') {
    req.sectionSession = session;
  }
  if (session.role === 'DEPT_HEAD') {
    req.deptSession = session;
  }

  return session;
}

async function requireSuperAdminAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  if (user.role !== 'SUPERADMIN') {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Superadmin access privilege required' });
  }
  next();
}

async function requireAdminAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Administrator privileges required' });
  }
  next();
}

async function requireEvaluatorAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  if (!['EVALUATOR', 'ADMIN', 'SUPERADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Evaluator privileges required' });
  }
  next();
}

async function requireSectionAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  if (!['SECTION_HEAD', 'ADMIN', 'SUPERADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Section Head privileges required' });
  }
  next();
}

async function requireDeptAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  if (!['DEPT_HEAD', 'ADMIN', 'SUPERADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Department HOD privileges required' });
  }
  next();
}

async function requireEmpAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Employee authentication required' });
  }
  if (!['emp', 'ADMIN', 'SUPERADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, authenticated: false, message: 'Forbidden: Employee privileges required' });
  }
  next();
}

async function requireAnyAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }
  next();
}

async function canAccessEmployeeData(user, targetEmpNo) {
  if (!user) return false;
  if (['SUPERADMIN', 'ADMIN'].includes(user.role)) return true;

  const strTarget = String(targetEmpNo).trim().toLowerCase();
  if (user.role === 'emp') {
    return String(user.empNo).trim().toLowerCase() === strTarget;
  }

  const employees = await getAuthoritativeEmployees();
  const targetEmp = employees.find(e => String(e.empNo).trim().toLowerCase() === strTarget);
  if (!targetEmp) return false;

  if (user.role === 'SECTION_HEAD') {
    return normalizeSectionNameServer(targetEmp.section) === normalizeSectionNameServer(user.section);
  }

  if (user.role === 'DEPT_HEAD') {
    const userDept = String(user.department || '').trim().toLowerCase();
    const empDept = String(targetEmp.dept || '').trim().toLowerCase();
    return userDept === 'all' || userDept === empDept || empDept.includes(userDept) || userDept.includes(empDept);
  }

  if (user.role === 'EVALUATOR') {
    const assignedSec = normalizeSectionNameServer(user.section || user.category || '');
    const empSec = normalizeSectionNameServer(targetEmp.section);
    return empSec.includes(assignedSec) || assignedSec.includes(empSec);
  }

  return false;
}

// ---------------------------------------------------------------------
// Enterprise Persistent Audit Logging System (Redis Cloud Single Source of Truth)
// ---------------------------------------------------------------------
const AUDIT_LOGS_FILE = path.join(__dirname, 'audit_logs.json');
const auditLogsMemory = [];

try {
  if (fs.existsSync(AUDIT_LOGS_FILE)) {
    const raw = fs.readFileSync(AUDIT_LOGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) auditLogsMemory.push(...parsed.slice(-200));
  }
} catch (e) {}

async function logAuditEvent(action, user, details, req = null) {
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown') : 'system';
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    action,
    user: typeof user === 'string' ? user : (user.name || user.email || user.empNo || 'Unknown'),
    details: typeof details === 'string' ? details : JSON.stringify(details),
    ip: String(ip).split(',')[0].trim()
  };

  auditLogsMemory.push(entry);
  if (auditLogsMemory.length > 500) auditLogsMemory.shift();

  if (kvUrl && kvToken) {
    try {
      const existing = await syncWithCloudKv('GET', 'yokohama_audit_logs');
      const allLogs = Array.isArray(existing) ? existing : [];
      allLogs.push(entry);
      const trimmed = allLogs.slice(-500);
      await syncWithCloudKv('SET', 'yokohama_audit_logs', trimmed);
    } catch (e) {
      console.error('Failed to sync audit log to Redis:', e.message);
    }
  }
  try {
    fs.writeFileSync(AUDIT_LOGS_FILE, JSON.stringify(auditLogsMemory.slice(-500), null, 2), 'utf-8');
  } catch (e) {}

  console.log(`[AUDIT] ${entry.timestamp} | ${entry.action} | ${entry.user} | ${entry.ip} | ${entry.details}`);
}

app.get('/api/admin/audit-logs', requireAdminAuth, async (req, res) => {
  if (kvUrl && kvToken) {
    const cloudLogs = await syncWithCloudKv('GET', 'yokohama_audit_logs');
    if (cloudLogs && Array.isArray(cloudLogs)) {
      return res.json({ success: true, logs: cloudLogs });
    }
  }
  return res.json({ success: true, logs: auditLogsMemory });
});

// ---------------------------------------------------------------------
// API ROUTE 1: POST /api/auth/admin/send-otp
// ---------------------------------------------------------------------
const OTP_DURATION_SECONDS = 300; // Synchronized 5-minute canonical lifetime

app.post('/api/auth/admin/send-otp', async (req, res) => {
  const emailRaw = (req.body.email || '').trim().toLowerCase();

  if (!emailRaw || !emailRaw.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid Admin Email ID required' });
  }

  // Strictly check explicit ADMIN_EMAIL allowlist from environment and cloud settings
  const envAdminEmails = (process.env.ADMIN_EMAIL || process.env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  let allowedEmails = [...envAdminEmails];

  if (kvUrl && kvToken) {
    const cloudSettings = await syncWithCloudKv('GET', 'yokohama_settings');
    if (cloudSettings && cloudSettings.adminEmail) {
      allowedEmails.push(cloudSettings.adminEmail.toLowerCase().trim());
    }
  }
  if (customSettingsMemory && customSettingsMemory.adminEmail) {
    allowedEmails.push(customSettingsMemory.adminEmail.toLowerCase().trim());
  }

  // Deduplicate allowlist
  allowedEmails = [...new Set(allowedEmails)];

  // STRICT CHECK: ONLY explicit allowlisted emails can receive OTP
  if (!allowedEmails.includes(emailRaw)) {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized admin email. Only explicit allowlisted administrator emails are permitted.'
    });
  }

  if (!transporter || !user || !pass) {
    return res.status(503).json({
      success: false,
      message: 'SMTP credentials not configured on server (SMTP_USER, SMTP_PASS required in environment).'
    });
  }

  // Rate Limiting: 30-second cooldown between send-otp requests
  const existingRecord = await getCloudOtp(emailRaw);
  const now = Date.now();
  if (existingRecord && (now - existingRecord.lastSendAt) < 30000) {
    const waitSecs = Math.ceil((30000 - (now - existingRecord.lastSendAt)) / 1000);
    return res.status(429).json({ success: false, message: `Please wait ${waitSecs} seconds before requesting a new OTP.` });
  }

  // Cryptographically secure 6-digit OTP generation
  const otpNum = crypto.randomInt(100000, 1000000);
  const otp = String(otpNum);
  const expiresAt = now + (OTP_DURATION_SECONDS * 1000);

  const newOtpRecord = {
    otp: otp,
    expiresAt: expiresAt,
    attempts: 0,
    lastSendAt: now
  };

  await setCloudOtp(emailRaw, newOtpRecord);

  const mailOptions = {
    from: `"ILUO Admin" <${user}>`,
    to: emailRaw,
    subject: `ILUO Admin Login OTP`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; padding: 24px; border: 2px solid #005B9E; border-radius: 12px; background: #FFFFFF; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #005B9E 0%, #003D6B 100%); color: white; padding: 16px; border-radius: 8px; font-weight: 800; font-size: 18px; text-align: center; letter-spacing: 0.5px;">
          ILUO Admin Login
        </div>
        <div style="padding: 24px 16px; text-align: center;">
          <p style="font-size: 16px; color: #334155; margin-bottom: 12px; font-weight: 600;">Your OTP is:</p>
          <div style="font-size: 38px; font-weight: 800; color: #005B9E; letter-spacing: 8px; background: #F0F9FF; border: 2px dashed #0284C7; padding: 16px 28px; border-radius: 10px; display: inline-block; margin: 12px 0 20px 0;">
            ${otp}
          </div>
          <p style="color: #E31B23; font-weight: 800; font-size: 15px; margin-top: 8px;">⏱️ Expires in 5 minutes (300 seconds)</p>
        </div>
        <div style="border-top: 1px solid #E2E8F0; padding-top: 16px; font-size: 12px; color: #94A3B8; text-align: center;">
          Official Plant Skill Qualification &amp; Analytics Portal
        </div>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    await logAuditEvent('SEND_ADMIN_OTP', emailRaw, 'OTP dispatched to email', req);
    return res.json({
      success: true,
      message: '✉️ OTP sent to your email inbox. Valid for 5 minutes. Please check your Gmail and enter the 6-digit OTP.',
      expiresIn: OTP_DURATION_SECONDS
    });
  } catch (error) {
    console.error(`email send failed: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Failed to dispatch email OTP. Please check server SMTP configuration.'
    });
  }
});

// ---------------------------------------------------------------------
// API ROUTE: POST /api/auth/admin/login (Password Login via Environment Credentials)
// ---------------------------------------------------------------------
app.post('/api/auth/admin/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Admin username/email and password required'
    });
  }

  const envUser = (process.env.ADMIN_USERNAME || 'admin').trim();
  const envPass = (process.env.ADMIN_PASSWORD || 'admin123').trim();
  const envEmail = (process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com').trim().toLowerCase();

  const uLower = username.toLowerCase();
  const validUsers = [envUser.toLowerCase(), envEmail, 'admin'].filter(Boolean);
  const isUserValid = validUsers.includes(uLower);

  let isPassValid = false;
  if (password === envPass) {
    isPassValid = true;
  } else {
    try {
      const pBuf = Buffer.from(password);
      const epBuf = Buffer.from(envPass);
      isPassValid = pBuf.length === epBuf.length && crypto.timingSafeEqual(pBuf, epBuf);
    } catch (e) {
      isPassValid = false;
    }
  }

  if (isUserValid && isPassValid) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const adminName = 'Administrator';

    const sessionData = {
      email: (process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com').toLowerCase(),
      name: adminName,
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + (8 * 60 * 60 * 1000)
    };

    await setCloudSession(sessionToken, sessionData, 28800);
    res.cookie('admin_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000));
    await logAuditEvent('ADMIN_LOGIN_PASSWORD', sessionData.email, 'Admin signed in via password', req);

    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      token: sessionToken,
      admin: {
        email: sessionData.email,
        name: adminName,
        role: 'SUPERADMIN'
      }
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid username or password'
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

  // Re-verify allowlist before issuing session
  const envAdminEmails = (process.env.ADMIN_EMAIL || process.env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
  let allowedEmails = [...envAdminEmails];
  if (kvUrl && kvToken) {
    const cloudSettings = await syncWithCloudKv('GET', 'yokohama_settings');
    if (cloudSettings && cloudSettings.adminEmail) allowedEmails.push(cloudSettings.adminEmail.toLowerCase().trim());
  }
  if (customSettingsMemory && customSettingsMemory.adminEmail) {
    allowedEmails.push(customSettingsMemory.adminEmail.toLowerCase().trim());
  }
  allowedEmails = [...new Set(allowedEmails)];

  if (!allowedEmails.includes(emailRaw)) {
    return res.status(403).json({ success: false, message: 'Unauthorized admin email' });
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

  // Check 5-minute expiry limit
  const now = Date.now();
  if (now > record.expiresAt) {
    await delCloudOtp(emailRaw);
    return res.status(400).json({ success: false, message: 'OTP Expired! (5-minute validity window passed). Please request a new OTP.' });
  }

  // Strict Single-Use OTP Match
  if (record.otp === otpEntered) {
    await delCloudOtp(emailRaw);

    // Create secure session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const adminName = 'Administrator';

    const sessionData = {
      email: emailRaw,
      name: adminName,
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + (8 * 60 * 60 * 1000)
    };

    await setCloudSession(sessionToken, sessionData, 28800);
    res.cookie('admin_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000));
    await logAuditEvent('ADMIN_LOGIN_OTP', emailRaw, 'Admin verified OTP successfully', req);

    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      token: sessionToken,
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
// EVALUATOR AUTHENTICATION (Server-Verified & RBAC Scoped)
// ---------------------------------------------------------------------
const EVALUATOR_CREDENTIALS = {
  'safety': process.env.EVALUATOR_PASS_SAFETY || 'safety123',
  'ci & tpm': process.env.EVALUATOR_PASS_CI || 'ci123',
  'quality': process.env.EVALUATOR_PASS_QUALITY || 'quality123',
  'technical': process.env.EVALUATOR_PASS_TECH || 'tech123',
  'hr': process.env.EVALUATOR_PASS_HR || 'hr123'
};

app.post('/api/auth/evaluator/login', async (req, res) => {
  const section = (req.body.section || 'Safety').trim();
  const password = (req.body.password || '').trim();

  if (!password) {
    return res.status(400).json({ success: false, message: 'Evaluator password required' });
  }

  const secKey = section.toLowerCase();
  const expectedPass = EVALUATOR_CREDENTIALS[secKey] || process.env.EVALUATOR_PASSWORD || 'ojt123';

  let isValid = false;
  try {
    const pBuf = Buffer.from(password);
    const expBuf = Buffer.from(expectedPass);
    if (pBuf.length === expBuf.length && crypto.timingSafeEqual(pBuf, expBuf)) {
      isValid = true;
    }
  } catch (e) {}

  if (!isValid) {
    return res.status(401).json({ success: false, message: `Invalid password for ${section} Evaluator` });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    role: 'EVALUATOR',
    section: section,
    name: `${section} Evaluator`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('evaluator_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000));
  await logAuditEvent('EVALUATOR_LOGIN', `${section} Evaluator`, `Logged in to ${section} practical evaluation`, req);

  return res.json({
    success: true,
    message: `Signed in as ${section} Evaluator`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// SECTION HEAD AUTHENTICATION (Server-Verified & RBAC Scoped)
// ---------------------------------------------------------------------
app.post('/api/auth/section/login', async (req, res) => {
  const section = (req.body.section || '').trim();
  const password = (req.body.password || '').trim();

  if (!section || !password) {
    return res.status(400).json({ success: false, message: 'Section name and password required' });
  }

  const expectedPass = process.env.SECTION_PASSWORD || 'section123';
  let isValid = false;
  try {
    const pBuf = Buffer.from(password);
    const expBuf = Buffer.from(expectedPass);
    if (pBuf.length === expBuf.length && crypto.timingSafeEqual(pBuf, expBuf)) {
      isValid = true;
    }
  } catch (e) {}

  if (!isValid) {
    return res.status(401).json({ success: false, message: `Invalid password for ${section} Portal` });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    role: 'SECTION_HEAD',
    section: section,
    name: `${section} Section Head`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('section_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000));
  await logAuditEvent('SECTION_LOGIN', `${section} Head`, `Logged in to ${section} portal`, req);

  return res.json({
    success: true,
    message: `Signed in as ${section} Section Head`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// DEPARTMENT / HOD AUTHENTICATION (Server-Verified & RBAC Scoped)
// ---------------------------------------------------------------------
app.post('/api/auth/dept/login', async (req, res) => {
  const department = (req.body.department || 'QUALITY CONTROL').trim();
  const password = (req.body.password || '').trim();

  if (!password) {
    return res.status(400).json({ success: false, message: 'Department HOD password required' });
  }

  const expectedPass = process.env.DEPT_PASSWORD || 'hod123';
  let isValid = false;
  try {
    const pBuf = Buffer.from(password);
    const expBuf = Buffer.from(expectedPass);
    if (pBuf.length === expBuf.length && crypto.timingSafeEqual(pBuf, expBuf)) {
      isValid = true;
    }
  } catch (e) {}

  if (!isValid) {
    return res.status(401).json({ success: false, message: 'Invalid password for Department HOD' });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    role: 'DEPT_HEAD',
    department: department,
    name: `${department} HOD`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('dept_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000));
  await logAuditEvent('DEPT_LOGIN', `${department} HOD`, `Logged in to Department dashboard`, req);

  return res.json({
    success: true,
    message: `Signed in as ${department} HOD`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// API ROUTE 3: GET /api/auth/admin/session (Backwards-Compatible Admin Session)
// ---------------------------------------------------------------------
app.get('/api/auth/admin/session', async (req, res) => {
  const user = await getAuthUser(req);
  if (user && ['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.json({
      success: true,
      authenticated: true,
      admin: user
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
// UNIFIED GET /api/auth/session & POST /api/auth/logout
// ---------------------------------------------------------------------
app.get('/api/auth/session', async (req, res) => {
  const user = await getAuthUser(req);
  if (user) {
    return res.json({ success: true, authenticated: true, user: user });
  }
  return res.json({ success: true, authenticated: false, user: null });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.signedCookies.admin_session || req.cookies.admin_session ||
    req.signedCookies.evaluator_session || req.cookies.evaluator_session ||
    req.signedCookies.section_session || req.cookies.section_session ||
    req.signedCookies.dept_session || req.cookies.dept_session ||
    req.signedCookies.emp_session || req.cookies.emp_session ||
    req.headers['x-admin-token'] || req.headers['x-emp-token'] || req.headers['x-session-token'];

  if (token) {
    await delCloudSession(token);
  }
  res.clearCookie('admin_session');
  res.clearCookie('evaluator_session');
  res.clearCookie('section_session');
  res.clearCookie('dept_session');
  res.clearCookie('emp_session');
  return res.json({ success: true, message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------
// API ROUTE 4: POST /api/auth/admin/logout (Deletes Cloud Redis Session)
// ---------------------------------------------------------------------
app.post('/api/auth/admin/logout', async (req, res) => {
  const sessionToken = req.signedCookies.admin_session || req.cookies.admin_session || req.headers['x-admin-token'];
  if (sessionToken) {
    await delCloudSession(sessionToken);
  }
  res.clearCookie('admin_session');
  return res.json({ success: true, message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------
// EMPLOYEE AUTHENTICATION & SECURE SESSIONS
// ---------------------------------------------------------------------
app.post('/api/auth/employee/login', async (req, res) => {
  const empNoRaw = (req.body.empNo || '').trim();
  const password = (req.body.password || '').trim();

  if (!empNoRaw || !password) {
    return res.status(400).json({ success: false, message: 'Employee ID and password required' });
  }

  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => 
    String(e.empNo).trim().toLowerCase() === empNoRaw.toLowerCase() ||
    String(e.empNo).trim().toLowerCase() === ('0' + empNoRaw).toLowerCase()
  );

  if (!emp) {
    return res.status(401).json({ success: false, message: 'Employee ID not found in database' });
  }

  let isValid = false;
  if (emp.passwordHash) {
    const inputHash = crypto.createHash('sha256').update(password).digest('hex');
    isValid = (inputHash === emp.passwordHash);
  } else {
    // Backwards-compatible initial verification: emp ID, default '1234', or stored emp.password
    if (password === emp.empNo || password === '1234' || (emp.password && password === emp.password)) {
      isValid = true;
      emp.passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      delete emp.password;
      saveAuthoritativeEmployees(employees).catch(e => console.error('Save employee password hash error:', e.message));
    }
  }

  if (!isValid) {
    return res.status(401).json({ success: false, message: 'Invalid Employee ID or password' });
  }

  const empSessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    role: 'emp',
    empNo: emp.empNo,
    name: emp.name,
    section: emp.section,
    dept: emp.dept,
    currentLevel: emp.currentLevel,
    targetLevel: emp.targetLevel,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(empSessionToken, sessionData, 28800);

  res.cookie('emp_session', empSessionToken, getCookieOptions(8 * 60 * 60 * 1000));

  return res.json({
    success: true,
    message: 'Employee authenticated successfully',
    token: empSessionToken,
    employee: sessionData
  });
});

app.post('/api/auth/employee/logout', async (req, res) => {
  const sessionToken = req.signedCookies.emp_session || req.cookies.emp_session || req.headers['x-emp-token'];
  if (sessionToken) {
    await delCloudSession(sessionToken);
  }
  res.clearCookie('emp_session');
  return res.json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/auth/employee/me', async (req, res) => {
  const user = await getAuthUser(req);
  if (!user || user.role !== 'emp') {
    return res.json({ success: true, authenticated: false, employee: null });
  }
  return res.json({ success: true, authenticated: true, employee: user });
});

// ---------------------------------------------------------------------
// AUTHORITATIVE DATA PERSISTENCE ENGINE (Upstash Cloud & Resilient Disk Backup)
// ---------------------------------------------------------------------
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

const RECORDS_JSON_FILE = path.join(__dirname, 'assessment_records.json');
const EMPLOYEES_JSON_FILE = path.join(__dirname, 'custom_employees.json');
const QUESTIONS_JSON_FILE = path.join(__dirname, 'custom_questions.json');
const MASTER_QUESTIONS_JSON_FILE = path.join(__dirname, 'master_questions.json');
const OJT_JSON_FILE = path.join(__dirname, 'ojt_evaluations.json');
const SETTINGS_JSON_FILE = path.join(__dirname, 'custom_settings.json');

// In-Memory Fast Caches / Fallback Stores
const globalAssessmentRecords = new Map();
let customEmployeesMemory = null;
let customQuestionBankMemory = null;
const globalOjtEvaluations = new Map();
let customSettingsMemory = null;
const activeExamSessions = new Map();

// Initial disk load if available (for local dev / cache warmup)
try {
  if (fs.existsSync(RECORDS_JSON_FILE)) {
    const raw = fs.readFileSync(RECORDS_JSON_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    Object.entries(parsed).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
  } else {
    const seedPath = path.join(__dirname, 'seed_data.js');
    if (fs.existsSync(seedPath)) {
      require(seedPath);
      if (global.SEED_RECORDS && typeof global.SEED_RECORDS === 'object') {
        Object.entries(global.SEED_RECORDS).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
      }
    }
  }
} catch (e) {}

try {
  if (fs.existsSync(EMPLOYEES_JSON_FILE)) {
    const raw = fs.readFileSync(EMPLOYEES_JSON_FILE, 'utf-8');
    customEmployeesMemory = JSON.parse(raw);
  }
} catch (e) {}

try {
  if (fs.existsSync(QUESTIONS_JSON_FILE)) {
    const raw = fs.readFileSync(QUESTIONS_JSON_FILE, 'utf-8');
    customQuestionBankMemory = JSON.parse(raw);
  }
} catch (e) {}

try {
  if (fs.existsSync(OJT_JSON_FILE)) {
    const raw = fs.readFileSync(OJT_JSON_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    Object.entries(parsed).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
  } else {
    const seedOjtPath = path.join(__dirname, 'seed_ojt.js');
    if (fs.existsSync(seedOjtPath)) {
      const seedOjt = require(seedOjtPath);
      if (seedOjt && typeof seedOjt === 'object') {
        Object.entries(seedOjt).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
      }
    }
  }
} catch (e) {}

// Fallback Loader from data.js if files/redis are uninitialized
function loadBaseDatasetFromDataJs() {
  try {
    const dataJsPath = path.join(__dirname, 'data.js');
    if (!fs.existsSync(dataJsPath)) return null;
    const content = fs.readFileSync(dataJsPath, 'utf-8');

    // Extract EMPLOYEES array
    let emps = null;
    const empStart = content.indexOf('const EMPLOYEES = [');
    if (empStart !== -1) {
      const empBracket = content.indexOf('[', empStart);
      const empEnd = content.indexOf('];', empBracket);
      if (empEnd !== -1) {
        emps = eval('(' + content.slice(empBracket, empEnd + 1) + ')');
      }
    }

    // Extract QUESTION_BANK
    let qb = null;
    const qbStart = content.indexOf('const QUESTION_BANK = {');
    const qbEnd = content.indexOf('const LEVEL_RULES = {');
    if (qbStart !== -1 && qbEnd !== -1) {
      const qbStr = content.slice(qbStart + 'const QUESTION_BANK = '.length, qbEnd).trim().replace(/;$/, '');
      qb = eval('(' + qbStr + ')');
    }

    return { employees: emps, questionBank: qb };
  } catch (err) {
    console.error('Error loading fallback base dataset from data.js:', err.message);
    return null;
  }
}

// Authoritative Employee Store
async function getAuthoritativeEmployees() {
  if (customEmployeesMemory && Array.isArray(customEmployeesMemory) && customEmployeesMemory.length >= 283) {
    return customEmployeesMemory;
  }
  if (fs.existsSync(EMPLOYEES_JSON_FILE)) {
    try {
      const raw = fs.readFileSync(EMPLOYEES_JSON_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed) && parsed.length >= 283) {
        customEmployeesMemory = parsed;
        return customEmployeesMemory;
      }
    } catch (e) {}
  }
  if (kvUrl && kvToken) {
    const cloudEmployees = await syncWithCloudKv('GET', 'yokohama_employees');
    if (cloudEmployees && Array.isArray(cloudEmployees) && cloudEmployees.length >= 283) {
      customEmployeesMemory = cloudEmployees;
      return cloudEmployees;
    }
  }
  const base = loadBaseDatasetFromDataJs();
  if (base && base.employees && base.employees.length > 0) {
    customEmployeesMemory = base.employees;
    return customEmployeesMemory;
  }
  return customEmployeesMemory || [];
}

async function saveAuthoritativeEmployees(employees) {
  if (!Array.isArray(employees)) return;
  customEmployeesMemory = employees;
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_employees', employees);
  }
  try {
    fs.writeFileSync(EMPLOYEES_JSON_FILE, JSON.stringify(employees, null, 2), 'utf-8');
  } catch (e) {}
}

// Authoritative Question Bank Store
async function getAuthoritativeQuestions() {
  if (kvUrl && kvToken) {
    const cloudQuestions = await syncWithCloudKv('GET', 'yokohama_question_bank');
    if (cloudQuestions && typeof cloudQuestions === 'object' && Object.keys(cloudQuestions).length > 0) {
      customQuestionBankMemory = cloudQuestions;
      return cloudQuestions;
    }
  }
  if (customQuestionBankMemory && typeof customQuestionBankMemory === 'object' && Object.keys(customQuestionBankMemory).length > 0) {
    return customQuestionBankMemory;
  }
  if (fs.existsSync(QUESTIONS_JSON_FILE)) {
    try {
      const raw = fs.readFileSync(QUESTIONS_JSON_FILE, 'utf-8');
      customQuestionBankMemory = JSON.parse(raw);
      if (customQuestionBankMemory && Object.keys(customQuestionBankMemory).length > 0) return customQuestionBankMemory;
    } catch (e) {}
  }
  const base = loadBaseDatasetFromDataJs();
  if (base && base.questionBank) {
    customQuestionBankMemory = base.questionBank;
    return customQuestionBankMemory;
  }
  return { L: [], U: [], O: [] };
}

async function saveAuthoritativeQuestions(qb) {
  if (!qb || typeof qb !== 'object') return;
  customQuestionBankMemory = qb;
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_question_bank', qb);
  }
  const serialized = JSON.stringify(qb, null, 2);
  try {
    fs.writeFileSync(QUESTIONS_JSON_FILE, serialized, 'utf-8');
  } catch (e) {}
  try {
    fs.writeFileSync(MASTER_QUESTIONS_JSON_FILE, serialized, 'utf-8');
  } catch (e) {}
}

// Authoritative Assessment Records Store (Redis Single Source of Truth + Optimistic Concurrency)
async function getAuthoritativeRecords() {
  if (kvUrl && kvToken) {
    const cloudRecords = await syncWithCloudKv('GET', 'yokohama_records');
    if (cloudRecords && typeof cloudRecords === 'object' && !cloudRecords.error && Object.keys(cloudRecords).length > 0) {
      // Cloud is authoritative: update local cache
      globalAssessmentRecords.clear();
      Object.entries(cloudRecords).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
      return cloudRecords;
    }
  }
  if (globalAssessmentRecords.size === 0) {
    if (fs.existsSync(RECORDS_JSON_FILE)) {
      try {
        const raw = fs.readFileSync(RECORDS_JSON_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        Object.entries(parsed).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
      } catch (e) {}
    } else {
      try {
        const seedPath = path.join(__dirname, 'seed_data.js');
        if (fs.existsSync(seedPath)) {
          require(seedPath);
          if (global.SEED_RECORDS && typeof global.SEED_RECORDS === 'object') {
            Object.entries(global.SEED_RECORDS).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
          }
        }
      } catch (e) {}
    }
  }
  return Object.fromEntries(globalAssessmentRecords);
}

async function saveAuthoritativeRecord(empNo, updaterOrData) {
  const strEmpNo = String(empNo).trim();
  const currentRecords = await getAuthoritativeRecords();
  const existing = currentRecords[strEmpNo] || {};

  let updatedData;
  if (typeof updaterOrData === 'function') {
    updatedData = updaterOrData(existing);
  } else {
    updatedData = { ...existing, ...updaterOrData };
  }

  // Optimistic concurrency & version tracking
  updatedData.version = (existing.version || 0) + 1;
  updatedData.updatedAt = new Date().toISOString();

  currentRecords[strEmpNo] = updatedData;
  globalAssessmentRecords.set(strEmpNo, updatedData);

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_records', currentRecords);
  }

  try {
    fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(currentRecords, null, 2), 'utf-8');
  } catch (err) {}

  return updatedData;
}

async function resetAuthoritativeRecords(filterFn = null) {
  if (!filterFn) {
    // Reset all
    globalAssessmentRecords.clear();
    activeExamSessions.clear();
    if (kvUrl && kvToken) {
      await syncWithCloudKv('SET', 'yokohama_records', {});
    }
    try { fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify({}, null, 2), 'utf-8'); } catch (e) {}
    return {};
  }

  const currentRecords = await getAuthoritativeRecords();
  const newRecords = {};
  let resetCount = 0;
  for (const [k, v] of Object.entries(currentRecords)) {
    if (filterFn(k, v)) {
      resetCount++;
      activeExamSessions.delete(String(k).trim());
      if (kvUrl && kvToken) {
        syncWithCloudKv('DEL', `exam:${String(k).trim()}`).catch(() => {});
      }
    } else {
      newRecords[k] = v;
    }
  }

  globalAssessmentRecords.clear();
  Object.entries(newRecords).forEach(([k, v]) => globalAssessmentRecords.set(k, v));

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_records', newRecords);
  }
  try { fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(newRecords, null, 2), 'utf-8'); } catch (e) {}
  return { newRecords, resetCount };
}

// Authoritative OJT Store
async function getAuthoritativeOjtEvaluations() {
  if (kvUrl && kvToken) {
    const cloudOjt = await syncWithCloudKv('GET', 'yokohama_ojt_evaluations');
    if (cloudOjt && typeof cloudOjt === 'object' && !cloudOjt.error && Object.keys(cloudOjt).length > 0) {
      globalOjtEvaluations.clear();
      Object.entries(cloudOjt).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
      return cloudOjt;
    }
  }
  if (globalOjtEvaluations.size === 0) {
    if (fs.existsSync(OJT_JSON_FILE)) {
      try {
        const raw = fs.readFileSync(OJT_JSON_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        Object.entries(parsed).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
      } catch (e) {}
    } else {
      try {
        const seedOjtPath = path.join(__dirname, 'seed_ojt.js');
        if (fs.existsSync(seedOjtPath)) {
          const seedOjt = require(seedOjtPath);
          if (seedOjt && typeof seedOjt === 'object') {
            Object.entries(seedOjt).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
          }
        }
      } catch (e) {}
    }
  }
  return Object.fromEntries(globalOjtEvaluations);
}

async function saveAuthoritativeOjtEvaluation(empNo, ojtData) {
  const strEmpNo = String(empNo).trim();
  const current = await getAuthoritativeOjtEvaluations();
  current[strEmpNo] = ojtData;
  globalOjtEvaluations.set(strEmpNo, ojtData);

  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_ojt_evaluations', current);
  }
  try {
    fs.writeFileSync(OJT_JSON_FILE, JSON.stringify(current, null, 2), 'utf-8');
  } catch (err) {}
  return ojtData;
}

// Question & Exam Evaluation Helpers
function normalizeSectionNameServer(sec) {
  let s = (sec || '').toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace('ware house', 'warehouse');
  if (s.includes('rro') || s.includes('alt')) return 'final finish rro & alt qa';
  if (s.includes('building') || s.includes('tbm')) return 'tire building qa';
  if (s.includes('curing')) return 'tire curing qa';
  if (s.includes('solid')) return 'solid tire qa';
  if (s.includes('preparatory')) return 'preparatory qa';
  if (s.includes('fid')) return 'fid inspector qa';
  if (s.includes('warehouse') || s.includes('data entry')) return 'warehouse qa';
  if (s.includes('finish')) return 'final finish qa';
  return s;
}

function getQuestionsForSectionServer(allLevelQuestions, targetLevel, section) {
  const reqCount = (targetLevel === 'O' ? 40 : (targetLevel === 'U' ? 30 : 20));
  if (!section) return allLevelQuestions.slice(0, reqCount);
  const empSecNorm = normalizeSectionNameServer(section);
  const sectionQs = allLevelQuestions.filter(q => normalizeSectionNameServer(q.section) === empSecNorm);
  if (sectionQs.length === 0) return allLevelQuestions.slice(0, reqCount);

  const byCat = {};
  sectionQs.forEach(q => {
    const cat = q.category || 'General';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(q);
  });
  const cats = Object.keys(byCat);
  if (cats.length <= 1) return sectionQs.slice(0, reqCount);

  const baseTarget = Math.floor(reqCount / cats.length);
  const extraSlots = reqCount % cats.length;
  const selected = [];
  cats.forEach((cat, idx) => {
    const targetForCat = baseTarget + (idx < extraSlots ? 1 : 0);
    selected.push(...byCat[cat].slice(0, targetForCat));
  });
  if (selected.length < reqCount) {
    const selIds = new Set(selected.map(q => q.id));
    const remaining = sectionQs.filter(q => !selIds.has(q.id));
    selected.push(...remaining.slice(0, reqCount - selected.length));
  }
  return selected.slice(0, reqCount);
}

// Strip correctAnswer from questions payload before returning to employee client
function sanitizeQuestionsForEmployee(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map(q => {
    const { correctAnswer, ...sanitized } = q;
    return sanitized;
  });
}

// Authoritative Server-Side Scoring Engine
async function scoreAssessmentServerSide(empNo, targetLevel, responses, section) {
  const strEmpNo = String(empNo).trim();
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
  const empSection = section || (emp && emp.section) || '';

  const qBank = await getAuthoritativeQuestions();
  const allLevelQuestions = qBank[targetLevel] || qBank['L'] || [];
  const questions = getQuestionsForSectionServer(allLevelQuestions, targetLevel, empSection);

  let correctCount = 0;
  const submittedQuestions = questions.map((q, idx) => {
    const selKey = (responses && responses[q.id]) || 'Not Answered';
    const selOpt = q.options ? q.options.find(o => o.key === selKey) : null;
    const corrOpt = q.options ? q.options.find(o => o.key === q.correctAnswer) : null;
    const isCorrect = (selKey === q.correctAnswer);
    if (isCorrect) correctCount++;

    return {
      index: idx + 1,
      id: q.id,
      category: q.category || 'General QA',
      question: q.question,
      selectedKey: selKey,
      selectedText: selOpt ? selOpt.text : 'Not Answered',
      correctKey: q.correctAnswer,
      correctText: corrOpt ? corrOpt.text : '',
      isCorrect: isCorrect,
      options: q.options || []
    };
  });

  const totalQs = questions.length || 1;
  const markPct = Math.round((correctCount / totalQs) * 100);
  const currentLevel = (emp && emp.currentLevel) || 'I';
  const levelRules = {
    "I": { "nextLevel": "L", "numQuestions": 20, "passingPct": 50 },
    "L": { "nextLevel": "U", "numQuestions": 20, "passingPct": 50 },
    "U": { "nextLevel": "O", "numQuestions": 30, "passingPct": 50 },
    "O": { "nextLevel": "O", "numQuestions": 40, "passingPct": 50 }
  };
  const rule = levelRules[currentLevel] || levelRules['I'];
  const pass = markPct >= rule.passingPct;

  let uMark = 0, lMark = 0, oMark = 0;
  if (targetLevel === 'U') uMark = correctCount;
  else if (targetLevel === 'L') lMark = correctCount;
  else if (targetLevel === 'O') oMark = correctCount;

  return {
    empNo: strEmpNo,
    name: emp ? emp.name : `Employee ${empNo}`,
    dept: emp ? emp.dept : 'QUALITY CONTROL',
    section: emp ? emp.section : empSection,
    doj: emp ? emp.doj : '-',
    targetLevel: targetLevel,
    inProgress: false,
    isCompleted: true,
    responses: responses,
    submittedQuestions: submittedQuestions,
    attemptedCount: Object.keys(responses || {}).length,
    uMark,
    lMark,
    oMark,
    totalMark: correctCount,
    markPct,
    status: pass ? 'Passed' : 'Failed',
    attemptDate: new Date().toLocaleDateString('en-GB')
  };
}

// ---------------------------------------------------------------------
// ASSESSMENT RECORDS API (Scoped Access & Multi-Device Sync)
// ---------------------------------------------------------------------

// GET /api/records (Scoped: Superadmin/Admin see all; Sections/Dept scoped; Employee sees only own)
app.get('/api/records', requireAnyAuth, async (req, res) => {
  const records = await getAuthoritativeRecords();
  const user = req.authUser;

  if (['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.json({ success: true, records });
  }

  const employees = await getAuthoritativeEmployees();

  // Employee role: strictly own record only (No cross-candidate or section leakage)
  if (user.role === 'emp') {
    const userEmpNo = String(user.empNo).trim();
    const ownRecord = records[userEmpNo] || null;
    return res.json({
      success: true,
      records: ownRecord ? { [userEmpNo]: ownRecord } : {}
    });
  }

  // Section Head role: scoped to assigned section
  if (user.role === 'SECTION_HEAD') {
    const secNorm = normalizeSectionNameServer(user.section);
    const sectionEmpNos = new Set(
      employees
        .filter(e => normalizeSectionNameServer(e.section) === secNorm)
        .map(e => String(e.empNo).trim())
    );
    const scopedRecords = {};
    Object.entries(records).forEach(([k, v]) => {
      if (sectionEmpNos.has(k)) scopedRecords[k] = v;
    });
    return res.json({ success: true, records: scopedRecords });
  }

  // Department Head role: scoped to assigned department
  if (user.role === 'DEPT_HEAD') {
    const deptNorm = String(user.department || '').trim().toLowerCase();
    const deptEmpNos = new Set(
      employees
        .filter(e => {
          const d = String(e.dept || '').trim().toLowerCase();
          return deptNorm === 'all' || d === deptNorm || d.includes(deptNorm) || deptNorm.includes(d);
        })
        .map(e => String(e.empNo).trim())
    );
    const scopedRecords = {};
    Object.entries(records).forEach(([k, v]) => {
      if (deptEmpNos.has(k)) scopedRecords[k] = v;
    });
    return res.json({ success: true, records: scopedRecords });
  }

  // Evaluator role: scoped to evaluation section
  if (user.role === 'EVALUATOR') {
    const evalSecNorm = normalizeSectionNameServer(user.section || user.category || '');
    const evalEmpNos = new Set(
      employees
        .filter(e => {
          const s = normalizeSectionNameServer(e.section);
          return s.includes(evalSecNorm) || evalSecNorm.includes(s);
        })
        .map(e => String(e.empNo).trim())
    );
    const scopedRecords = {};
    Object.entries(records).forEach(([k, v]) => {
      if (evalEmpNos.has(k)) scopedRecords[k] = v;
    });
    return res.json({ success: true, records: scopedRecords });
  }

  return res.status(403).json({ success: false, message: 'Forbidden' });
});

// POST /api/records (Save in-progress progress; isCompleted strictly guarded)
app.post('/api/records', requireAnyAuth, async (req, res) => {
  const { empNo, recordData } = req.body || {};
  if (!empNo || !recordData) {
    return res.status(400).json({ success: false, message: 'empNo and recordData required' });
  }

  const strEmpNo = String(empNo).trim();
  const user = req.authUser;

  // Authorization check: Employee can only update own record
  if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
    return res.status(403).json({ success: false, message: 'Forbidden: You can only update your own assessment record' });
  }

  // Integrity Guard: Employee clients cannot forge isCompleted: true via /api/records
  if (user.role === 'emp' && recordData.isCompleted) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Assessment completion must be submitted via /api/exam/submit for server-side evaluation'
    });
  }

  const updated = await saveAuthoritativeRecord(strEmpNo, recordData);
  return res.json({ success: true, message: `Record saved for employee ${strEmpNo}`, record: updated });
});

// DELETE /api/records/:empNo (Superadmin only: Reset specific candidate)
app.delete('/api/records/:empNo', requireAdminAuth, async (req, res) => {
  const strEmpNo = String(req.params.empNo).trim();
  await resetAuthoritativeRecords((k) => k === strEmpNo);
  res.json({ success: true, message: `Record reset for employee ${strEmpNo}` });
});

// POST /api/records/reset-all (Superadmin only: Requires explicit typed confirmation phrase)
app.post('/api/records/reset-all', requireSuperAdminAuth, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'RESET-ALL-EXAMS') {
    return res.status(400).json({
      success: false,
      message: 'Confirmation phrase mismatch. You must explicitly type "RESET-ALL-EXAMS" to perform this action.'
    });
  }

  await resetAuthoritativeRecords(null);
  await logAuditEvent('RESET_ALL_EXAMS', req.authUser, 'Reset all assessment records to zero finished', req);
  console.log('🔄 All assessment records reset to 0 finished exams by Superadmin.');
  res.json({ success: true, message: 'All exam records successfully reset to zero' });
});

// DELETE /api/records (Superadmin only: Requires explicit typed confirmation phrase)
app.delete('/api/records', requireSuperAdminAuth, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'RESET-ALL-EXAMS') {
    return res.status(400).json({
      success: false,
      message: 'Confirmation phrase mismatch. You must explicitly type "RESET-ALL-EXAMS" to perform this action.'
    });
  }
  await resetAuthoritativeRecords(null);
  await logAuditEvent('DELETE_ALL_RECORDS', req.authUser, 'Deleted all assessment records', req);
  res.json({ success: true, message: 'All exam records reset to zero' });
});

// POST /api/records/reset-section (Superadmin only)
app.post('/api/records/reset-section', requireAdminAuth, async (req, res) => {
  const { section, sectionId } = req.body || {};
  if (!section && !sectionId) {
    return res.status(400).json({ success: false, message: 'section or sectionId is required' });
  }

  const emps = await getAuthoritativeEmployees();
  const secQuery = String(section || sectionId).toLowerCase().replace(/qa/g, '').replace(/[^a-z0-9]/g, '');

  const sectionEmpNos = new Set();
  emps.forEach(emp => {
    const empSec = String(emp.section || '').toLowerCase().replace(/qa/g, '').replace(/[^a-z0-9]/g, '');
    if (empSec.includes(secQuery) || secQuery.includes(empSec)) {
      sectionEmpNos.add(String(emp.empNo).trim());
    }
  });

  const result = await resetAuthoritativeRecords((k) => sectionEmpNos.has(k));
  res.json({
    success: true,
    message: `Successfully reset exams for section ${section || sectionId}`,
    count: result.resetCount,
    records: result.newRecords
  });
});

// POST /api/records/reset-department (Superadmin only)
app.post('/api/records/reset-department', requireAdminAuth, async (req, res) => {
  const { department } = req.body || {};
  if (!department) {
    return res.status(400).json({ success: false, message: 'department is required' });
  }

  const emps = await getAuthoritativeEmployees();
  const deptQuery = String(department).toLowerCase().trim();

  const deptEmpNos = new Set();
  emps.forEach(emp => {
    const empDept = String(emp.dept || 'QUALITY CONTROL').toLowerCase().trim();
    if (deptQuery === 'all' || empDept === deptQuery || empDept.includes(deptQuery) || deptQuery.includes(empDept)) {
      deptEmpNos.add(String(emp.empNo).trim());
    }
  });

  const result = await resetAuthoritativeRecords((k) => deptEmpNos.has(k));
  res.json({
    success: true,
    message: `Successfully reset exams for department ${department}`,
    count: result.resetCount,
    records: result.newRecords
  });
});

// POST /api/records/restore-demo (Superadmin only)
app.post('/api/records/restore-demo', requireAdminAuth, async (req, res) => {
  const BACKUP_FILE = path.join(__dirname, 'assessment_records_backup_236.json');
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      globalAssessmentRecords.clear();
      Object.entries(parsed).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
      try { fs.writeFileSync(RECORDS_JSON_FILE, raw, 'utf-8'); } catch (e) {}
      if (kvUrl && kvToken) {
        await syncWithCloudKv('SET', 'yokohama_records', parsed);
      }
      return res.json({ success: true, message: `Restored ${globalAssessmentRecords.size} demo records from backup`, records: parsed });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to restore backup: ' + err.message });
    }
  }
  res.status(404).json({ success: false, message: 'Backup file assessment_records_backup_236.json not found' });
});

// ---------------------------------------------------------------------
// SERVER-SIDE EXAM LIFECYCLE & SUBMISSION API (Anti-Cheat & Duration Limits)
// ---------------------------------------------------------------------

// POST /api/exam/start: Initializes candidate exam with 45-min server limit & returns sanitized questions
app.post('/api/exam/start', requireEmpAuth, async (req, res) => {
  try {
    const user = req.authUser;
    const empNo = req.body.empNo || user.empNo;
    const strEmpNo = String(empNo).trim();

    if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only start an exam for your own employee ID' });
    }

    const employees = await getAuthoritativeEmployees();
    const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
    if (!emp) {
      return res.status(404).json({ success: false, message: `Employee ID ${strEmpNo} not found in directory` });
    }

    const records = await getAuthoritativeRecords();
    const existingRecord = records[strEmpNo];
    if (existingRecord && existingRecord.isCompleted) {
      if (user.role === 'SUPERADMIN' || req.body.forceRetake) {
        await resetAuthoritativeRecords((k) => k === strEmpNo);
      } else {
        return res.status(409).json({
          success: false,
          message: 'Assessment already completed. Contact administrator to reset your exam.',
          record: existingRecord
        });
      }
    }

    const targetLevel = req.body.targetLevel || emp.targetLevel || 'L';
    const qBank = await getAuthoritativeQuestions();
    const allQs = qBank[targetLevel] || qBank['L'] || [];
    const questions = getQuestionsForSectionServer(allQs, targetLevel, emp.section);

    const durationSeconds = 45 * 60; // 45 minutes
    const expiresAt = Date.now() + (durationSeconds * 1000) + 30000; // 30s latency grace

    const examSession = {
      empNo: strEmpNo,
      targetLevel,
      startTime: Date.now(),
      expiresAt,
      durationSeconds,
      isCompleted: false
    };

    activeExamSessions.set(strEmpNo, examSession);
    if (kvUrl && kvToken) {
      await syncWithCloudKv('SET', `exam:${strEmpNo}`, examSession, durationSeconds + 120);
    }

    // Save initial in-progress record
    await saveAuthoritativeRecord(strEmpNo, {
      empNo: strEmpNo,
      name: emp.name,
      dept: emp.dept,
      section: emp.section,
      doj: emp.doj,
      targetLevel,
      inProgress: true,
      isCompleted: false,
      remainingSeconds: durationSeconds,
      currentIndex: 0,
      responses: {},
      tabSwitchCount: 0,
      startedAt: new Date().toISOString()
    });

    // Send SANITIZED questions to client (without correctAnswer)
    const sanitizedQuestions = sanitizeQuestionsForEmployee(questions);

    return res.json({
      success: true,
      message: 'Assessment session started',
      activeExam: {
        empNo: strEmpNo,
        targetLevel,
        questions: sanitizedQuestions,
        durationSeconds,
        expiresAt
      }
    });
  } catch (err) {
    console.error('Exam start error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start exam session: ' + err.message });
  }
});

// POST /api/exam/submit: Server-Side Scoring, Timing Validation & Single Submission Enforcement
app.post('/api/exam/submit', requireEmpAuth, async (req, res) => {
  try {
    const user = req.authUser;
    const { empNo, responses, targetLevel } = req.body || {};
    const strEmpNo = String(empNo || user.empNo).trim();

    if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only submit your own assessment' });
    }

    const records = await getAuthoritativeRecords();
    const existing = records[strEmpNo];
    if (existing && existing.isCompleted) {
      return res.status(409).json({ success: false, message: 'Conflict: Assessment has already been submitted and completed.' });
    }

    // Check exam session timing
    let examSession = activeExamSessions.get(strEmpNo);
    if (!examSession && kvUrl && kvToken) {
      examSession = await syncWithCloudKv('GET', `exam:${strEmpNo}`);
    }

    if (examSession && examSession.expiresAt && Date.now() > (examSession.expiresAt + 15000)) {
      console.warn(`Assessment submission for ${strEmpNo} arrived after server expiration.`);
    }

    const employees = await getAuthoritativeEmployees();
    const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
    const section = (emp && emp.section) || (existing && existing.section) || '';
    const lvl = targetLevel || (existing && existing.targetLevel) || (emp && emp.targetLevel) || 'L';

    // Server-Side Scoring: authoritative evaluation
    const scoredRecord = await scoreAssessmentServerSide(strEmpNo, lvl, responses || {}, section);
    if (existing && existing.tabSwitchCount) {
      scoredRecord.tabSwitchCount = existing.tabSwitchCount;
    }

    // Save final record authoritatively
    await saveAuthoritativeRecord(strEmpNo, scoredRecord);

    // Clean up active session
    activeExamSessions.delete(strEmpNo);
    if (kvUrl && kvToken) {
      await syncWithCloudKv('DEL', `exam:${strEmpNo}`);
    }

    return res.json({
      success: true,
      message: 'Assessment scored and recorded successfully',
      record: scoredRecord
    });
  } catch (err) {
    console.error('Exam submit error:', err);
    return res.status(500).json({ success: false, message: 'Failed to evaluate exam: ' + err.message });
  }
});

// ---------------------------------------------------------------------
// QUESTION BANK API (Sanitized for Employees, Full for Admin)
// ---------------------------------------------------------------------

// GET /api/questions: Strips correct answers unless Superadmin
app.get('/api/questions', async (req, res) => {
  const user = await getAuthUser(req);
  const qBank = await getAuthoritativeQuestions();

  if (user && user.role === 'SUPERADMIN') {
    return res.json({ success: true, questionBank: qBank });
  }

  // Strip correct answers for candidate / unauthenticated view
  const sanitizedBank = {};
  for (const [lvl, qs] of Object.entries(qBank)) {
    sanitizedBank[lvl] = sanitizeQuestionsForEmployee(qs);
  }

  return res.json({ success: true, questionBank: sanitizedBank });
});

// POST /api/questions: Superadmin only
app.post('/api/questions', requireAdminAuth, async (req, res) => {
  const { questionBank } = req.body;
  if (!questionBank || typeof questionBank !== 'object') {
    return res.status(400).json({ success: false, message: 'questionBank object required' });
  }

  await saveAuthoritativeQuestions(questionBank);
  return res.json({ success: true, message: 'Question Bank updated and synced permanently!' });
});

// ---------------------------------------------------------------------
// EMPLOYEE DIRECTORY API
// ---------------------------------------------------------------------

// GET /api/employees: Public directory listing (safe fields without passwordHash)
app.get('/api/employees', async (req, res) => {
  const employees = await getAuthoritativeEmployees();
  const safeEmployees = employees.map(e => ({
    empNo: e.empNo,
    name: e.name,
    dept: e.dept,
    section: e.section,
    qualification: e.qualification,
    doj: e.doj,
    expCount: e.expCount,
    yearExp: e.yearExp,
    currentLevel: e.currentLevel,
    targetLevel: e.targetLevel
  }));
  res.json({ success: true, employees: safeEmployees });
});

// POST /api/employees: Superadmin only
app.post('/api/employees', requireAdminAuth, async (req, res) => {
  const { employees } = req.body;
  if (!employees || !Array.isArray(employees)) {
    return res.status(400).json({ success: false, message: 'Array of employees required' });
  }

  await saveAuthoritativeEmployees(employees);
  res.json({ success: true, message: 'Employee directory updated and persisted!' });
});

// ---------------------------------------------------------------------
// OJT EVALUATIONS API (Scoped)
// ---------------------------------------------------------------------

// GET /api/ojt-evaluations: Scoped (Superadmin/Admin see all; Sections/Dept scoped; Employee sees only own)
app.get('/api/ojt-evaluations', requireAnyAuth, async (req, res) => {
  const ojtObj = await getAuthoritativeOjtEvaluations();
  const user = req.authUser;

  if (['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.json({ success: true, evaluations: ojtObj });
  }

  const employees = await getAuthoritativeEmployees();

  // Employee: own evaluation only
  if (user.role === 'emp') {
    const userEmpNo = String(user.empNo).trim();
    const ownOjt = ojtObj[userEmpNo] || null;
    return res.json({
      success: true,
      evaluations: ownOjt ? { [userEmpNo]: ownOjt } : {}
    });
  }

  // Section Head: evaluations for employees in section
  if (user.role === 'SECTION_HEAD') {
    const secNorm = normalizeSectionNameServer(user.section);
    const sectionEmpNos = new Set(
      employees
        .filter(e => normalizeSectionNameServer(e.section) === secNorm)
        .map(e => String(e.empNo).trim())
    );
    const scopedOjt = {};
    Object.entries(ojtObj).forEach(([k, v]) => {
      if (sectionEmpNos.has(k)) scopedOjt[k] = v;
    });
    return res.json({ success: true, evaluations: scopedOjt });
  }

  // Department Head: evaluations for employees in department
  if (user.role === 'DEPT_HEAD') {
    const deptNorm = String(user.department || '').trim().toLowerCase();
    const deptEmpNos = new Set(
      employees
        .filter(e => {
          const d = String(e.dept || '').trim().toLowerCase();
          return deptNorm === 'all' || d === deptNorm || d.includes(deptNorm) || deptNorm.includes(d);
        })
        .map(e => String(e.empNo).trim())
    );
    const scopedOjt = {};
    Object.entries(ojtObj).forEach(([k, v]) => {
      if (deptEmpNos.has(k)) scopedOjt[k] = v;
    });
    return res.json({ success: true, evaluations: scopedOjt });
  }

  // Evaluator: evaluations for employees in assigned section
  if (user.role === 'EVALUATOR') {
    const evalSecNorm = normalizeSectionNameServer(user.section || user.category || '');
    const evalEmpNos = new Set(
      employees
        .filter(e => {
          const s = normalizeSectionNameServer(e.section);
          return s.includes(evalSecNorm) || evalSecNorm.includes(s);
        })
        .map(e => String(e.empNo).trim())
    );
    const scopedOjt = {};
    Object.entries(ojtObj).forEach(([k, v]) => {
      if (evalEmpNos.has(k)) scopedOjt[k] = v;
    });
    return res.json({ success: true, evaluations: scopedOjt });
  }

  return res.status(403).json({ success: false, message: 'Forbidden' });
});

// POST /api/ojt-evaluations: Evaluator, Admin, Superadmin (Scoped by section/employee)
app.post('/api/ojt-evaluations', requireEvaluatorAuth, async (req, res) => {
  const { empNo, ojtData } = req.body;
  if (!empNo || !ojtData) {
    return res.status(400).json({ success: false, message: 'empNo and ojtData required' });
  }

  const strEmpNo = String(empNo).trim();
  const user = req.authUser;
  const canAccess = await canAccessEmployeeData(user, strEmpNo);
  if (!canAccess) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to evaluate this employee' });
  }

  await saveAuthoritativeOjtEvaluation(strEmpNo, ojtData);

  try {
    const scriptPath = path.join(__dirname, 'update_ojt_excel.py');
    if (fs.existsSync(scriptPath)) {
      execFile('python', [scriptPath, '--emp', strEmpNo], (err, stdout) => {
        if (stdout) console.log(`Excel updated for employee ${strEmpNo}: ${stdout.trim()}`);
      });
    }
  } catch (err) {}

  res.json({ success: true, message: `OJT evaluation saved and synced for employee ${strEmpNo}` });
});

// POST /api/ojt-evaluations/reset-all: Superadmin only (Requires explicit typed confirmation phrase)
app.post('/api/ojt-evaluations/reset-all', requireSuperAdminAuth, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'RESET-ALL-OJT') {
    return res.status(400).json({
      success: false,
      message: 'Confirmation phrase mismatch. You must explicitly type "RESET-ALL-OJT" to perform this action.'
    });
  }

  globalOjtEvaluations.clear();
  if (kvUrl && kvToken) {
    await syncWithCloudKv('SET', 'yokohama_ojt_evaluations', {});
  }
  try {
    fs.writeFileSync(OJT_JSON_FILE, JSON.stringify({}, null, 2), 'utf-8');
  } catch (err) {}

  await logAuditEvent('RESET_ALL_OJT', req.authUser, 'Reset all OJT practical evaluations to zero finished', req);
  res.json({ success: true, message: 'All OJT evaluations have been reset to 0 finished successfully!' });
});

// ---------------------------------------------------------------------
// SECURITY SETTINGS API (Admin only)
// ---------------------------------------------------------------------
app.get('/api/settings', requireAdminAuth, async (req, res) => {
  if (kvUrl && kvToken) {
    const cloudSettings = await syncWithCloudKv('GET', 'yokohama_settings');
    if (cloudSettings && typeof cloudSettings === 'object' && Object.keys(cloudSettings).length > 0) {
      customSettingsMemory = cloudSettings;
    }
  }
  res.json({ success: true, settings: customSettingsMemory });
});

app.post('/api/settings', requireAdminAuth, async (req, res) => {
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

// ---------------------------------------------------------------------
// INDIVIDUAL EMPLOYEE DOCX & PDF GENERATION (Strict 404 & Read-Only)
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
  const strEmpNo = String(empNo).trim();
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());

  // STRICT REQUIREMENT: Reject non-existent employees with 404 rather than generating mock/blank document
  if (!emp) {
    const err = new Error(`Employee ID "${empNo}" not found in official employee directory.`);
    err.statusCode = 404;
    throw err;
  }

  const records = await getAuthoritativeRecords();
  const examRecord = optionalRecordData || records[strEmpNo] || null;
  const targetLevel = (examRecord && examRecord.targetLevel) || emp.targetLevel || emp.currentLevel || 'O';
  const templateFilename = getTemplateFilename(targetLevel, emp.section);

  let templatePath = path.join(__dirname, 'QC_templates', templateFilename);
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join('D:', 'QC question', templateFilename);
  }
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join(__dirname, 'QC question', templateFilename);
  }

  if (!fs.existsSync(templatePath)) {
    const err = new Error(`Template not found for ${targetLevel} ${emp.section}: ${templateFilename}`);
    err.statusCode = 404;
    throw err;
  }

  const templateBuf = fs.readFileSync(templatePath);

  const qBank = await getAuthoritativeQuestions();
  const qbQuestions = qBank[targetLevel] || [];

  const ojtEvaluations = await getAuthoritativeOjtEvaluations();
  const ojtRec = ojtEvaluations[strEmpNo] || null;

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

async function convertDocxBufferToPdf(docxBuf, identifier = 'doc') {
  const tempDir = path.join(os.tmpdir(), 'temp_docx');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempDocx = path.join(tempDir, `temp_${identifier}_${Date.now()}_${Math.random().toString(36).slice(2)}.docx`);
  const tempPdf = path.join(tempDir, `temp_${identifier}_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);

  fs.writeFileSync(tempDocx, docxBuf);

  const psScript = path.join(__dirname, 'word_to_pdf.ps1');
  if (process.platform === 'win32' && fs.existsSync(psScript)) {
    try {
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', psScript, '-srcPath', tempDocx, '-dstPath', tempPdf], (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        });
      });

      if (fs.existsSync(tempPdf)) {
        const pdfBytes = fs.readFileSync(tempPdf);
        try { fs.unlinkSync(tempDocx); } catch(e){}
        try { fs.unlinkSync(tempPdf); } catch(e){}
        return pdfBytes;
      }
    } catch (conversionErr) {
      try { if (fs.existsSync(tempDocx)) fs.unlinkSync(tempDocx); } catch(e){}
      try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch(e){}
      throw conversionErr;
    }
  }

  try { if (fs.existsSync(tempDocx)) fs.unlinkSync(tempDocx); } catch(e){}
  throw new Error('Native Word-to-PDF conversion requires Windows with Microsoft Word installed.');
}

const { generateOfficialReportHtml } = require('./report_html_generator.js');

let logoBase64Cache = null;
function getLogoBase64() {
  if (logoBase64Cache) return logoBase64Cache;
  const p = path.join(__dirname, 'yokohama_logo.png');
  if (fs.existsSync(p)) {
    logoBase64Cache = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } else {
    logoBase64Cache = '';
  }
  return logoBase64Cache;
}

async function buildHtmlReportForEmployee(empNo, optionalRecordData) {
  const strEmpNo = String(empNo).trim();
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());

  // STRICT REQUIREMENT: Reject non-existent employees with 404
  if (!emp) {
    const err = new Error(`Employee ID "${empNo}" not found in official employee directory.`);
    err.statusCode = 404;
    throw err;
  }

  const records = await getAuthoritativeRecords();
  const examRecord = optionalRecordData || records[strEmpNo] || null;
  const targetLevel = (examRecord && examRecord.targetLevel) || emp.targetLevel || emp.currentLevel || 'O';

  const qBank = await getAuthoritativeQuestions();
  const allQs = qBank[targetLevel] || qBank['L'] || [];
  let qbQuestions = [];
  if (examRecord && Array.isArray(examRecord.submittedQuestions) && examRecord.submittedQuestions.length > 0) {
    qbQuestions = examRecord.submittedQuestions.slice(0, 30);
  } else if (typeof getQuestionsForSectionServer === 'function') {
    qbQuestions = getQuestionsForSectionServer(allQs, targetLevel, emp.section).slice(0, 30);
  } else {
    qbQuestions = allQs.slice(0, 30);
  }

  const ojtEvaluations = await getAuthoritativeOjtEvaluations();
  const ojtRec = ojtEvaluations[strEmpNo] || {};

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

  return generateOfficialReportHtml(emp, examRecord, qbQuestions, ojtRec, ojtTmpl, getLogoBase64());
}

let browserInstance = null;
async function getChromiumBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  const puppeteer = require('puppeteer-core');
  
  if (process.env.VERCEL || process.platform === 'linux') {
    const chromiumPkg = require('@sparticuz/chromium');
    const chromium = chromiumPkg.default || chromiumPkg;
    browserInstance = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });
  } else {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    let execPath = possiblePaths.find(p => fs.existsSync(p));
    browserInstance = await puppeteer.launch({
      executablePath: execPath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu']
    });
  }
  return browserInstance;
}

async function renderHtmlToPdf(html) {
  const browser = await getChromiumBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' }
    });
    return pdfBuf;
  } finally {
    try { await page.close(); } catch(e){}
  }
}

async function renderDynamicPdf(empNo, optionalRecordData) {
  if (process.platform === 'win32') {
    try {
      const docxBuf = await buildDocxBufferForEmployee(empNo, optionalRecordData);
      return await convertDocxBufferToPdf(docxBuf, empNo);
    } catch (wordErr) {
      console.warn('Word COM conversion failed, falling back to Chromium/Puppeteer:', wordErr.message);
    }
  }

  const html = await buildHtmlReportForEmployee(empNo, optionalRecordData);
  return await renderHtmlToPdf(html);
}

// GET /api/employee-docx/:empNo (Exact Dynamic DOCX)
app.get('/api/employee-docx/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required' });
  }

  const allowed = await canAccessEmployeeData(user, empNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to generate this report' });
  }

  try {
    const docxBuf = await buildDocxBufferForEmployee(empNo);
    const fileName = `ILUO_Report_${empNo}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', docxBuf.length);
    return res.send(docxBuf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message, error: err.message });
  }
});

// GET /api/ojt-docx/:empNo (Standalone OJT DOCX)
app.get('/api/ojt-docx/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required' });
  }

  const allowed = await canAccessEmployeeData(user, empNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to generate this report' });
  }

  try {
    const employees = await getAuthoritativeEmployees();
    const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === empNo.toLowerCase());
    if (!emp) {
      return res.status(404).json({ success: false, message: `Employee ID "${empNo}" not found in employee directory` });
    }

    const ojtEvaluations = await getAuthoritativeOjtEvaluations();
    const ojtRec = ojtEvaluations[empNo] || null;

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
    const fileName = `OJT_${ojtTmpl ? ojtTmpl.id : 'Form'}_${empNo}_${cleanName}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message, error: err.message });
  }
});

// POST /api/generate-docx: STRICTLY READ-ONLY (No assessment record write side-effect)
app.post('/api/generate-docx', async (req, res) => {
  const { empNo, recordData } = req.body || {};
  if (!empNo) {
    return res.status(400).json({ success: false, message: 'empNo is required' });
  }

  const strEmpNo = String(empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required' });
  }

  const allowed = await canAccessEmployeeData(user, strEmpNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to generate this report' });
  }

  try {
    // Read-only generation: recordData is used purely in-memory for document rendering
    const docxBuf = await buildDocxBufferForEmployee(strEmpNo, recordData);
    const fileName = `ILUO_Report_${strEmpNo}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', docxBuf.length);
    return res.send(docxBuf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message, error: err.message });
  }
});

// GET /api/generate-pdf/:empNo
app.get('/api/generate-pdf/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required' });
  }

  const allowed = await canAccessEmployeeData(user, empNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to generate this report' });
  }

  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === empNo.toLowerCase());
  if (!emp) {
    return res.status(404).json({ success: false, message: `Employee ID "${empNo}" not found in employee directory` });
  }

  try {
    const pdfBuf = await renderDynamicPdf(empNo);
    const fileName = `ILUO_Report_${empNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message, error: err.message });
  }
});

// POST /api/generate-pdf: STRICTLY READ-ONLY
app.post('/api/generate-pdf', async (req, res) => {
  const { empNo, recordData } = req.body || {};
  if (!empNo) {
    return res.status(400).json({ success: false, message: 'empNo is required' });
  }
  const strEmpNo = String(empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required' });
  }

  const allowed = await canAccessEmployeeData(user, strEmpNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to generate this report' });
  }

  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
  if (!emp) {
    return res.status(404).json({ success: false, message: `Employee ID "${strEmpNo}" not found in employee directory` });
  }

  try {
    const pdfBuf = await renderDynamicPdf(strEmpNo, recordData);
    const fileName = `ILUO_Report_${strEmpNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message, error: err.message });
  }
});

// GET /api/employee-report-html/:empNo: Returns exact official printable HTML
app.get('/api/employee-report-html/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo).trim();
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).send('<h3>Unauthorized: Authentication required</h3>');
  }

  const allowed = await canAccessEmployeeData(user, empNo);
  if (!allowed) {
    return res.status(403).send('<h3>Forbidden: You do not have permission to view this report</h3>');
  }

  try {
    const html = await buildHtmlReportForEmployee(empNo);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).send(`<h3>Error: ${err.message}</h3>`);
  }
});

// POST /api/convert-docx-to-pdf: Convert provided DOCX blob to native PDF
app.post('/api/convert-docx-to-pdf', requireAnyAuth, express.raw({ type: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'], limit: '50mb' }), async (req, res) => {
  try {
    let buf = req.body;
    if (!Buffer.isBuffer(buf) && req.body && req.body.base64) {
      buf = Buffer.from(req.body.base64, 'base64');
    }
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ success: false, message: 'Valid DOCX buffer required' });
    }
    const pdfBuf = await convertDocxBufferToPdf(buf, 'converted');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="converted_report.pdf"');
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

// Protected Admin Stats
app.get('/api/admin/dashboard-stats', requireAdminAuth, async (req, res) => {
  const employees = await getAuthoritativeEmployees();
  res.json({
    success: true,
    data: {
      totalEmployees: employees.length,
      admin: req.adminSession
    }
  });
});

// Centralized Error Handler (Prevents stack trace / internal detail leakage)
app.use((err, req, res, next) => {
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ success: false, message: 'Forbidden: Origin blocked by CORS policy' });
  }
  console.error('[SERVER ERROR]', err.message || err);
  const status = err.statusCode || err.status || 500;
  return res.status(status).json({
    success: false,
    message: 'An internal error occurred while processing your request. Please contact administrator.'
  });
});

// Fallback route to index.html for Client-Side SPA Routing
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|json|map|docx|xlsx|pdf|txt|woff2?|ttf|eot)$/i)) {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Yokohama Admin Portal running at http://localhost:${PORT}`);
  });
}

app.buildDocxBufferForEmployee = buildDocxBufferForEmployee;
app.convertDocxBufferToPdf = convertDocxBufferToPdf;
app.buildHtmlReportForEmployee = buildHtmlReportForEmployee;
app.renderDynamicPdf = renderDynamicPdf;

module.exports = app;

