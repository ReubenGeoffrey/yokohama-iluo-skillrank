require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const Tokens = require('csrf');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const csrfTokens = new Tokens();
const {
  DEPARTMENTS,
  QA_SECTIONS,
  PRODUCTION_SECTIONS,
  ILUO_LEVELS,
  DEFAULT_SETTINGS,
  normalizeQaSectionKey,
  canonicalQaSectionName,
  normalizeDepartmentName,
  calculateDojEligibility,
  escapeHtml
} = require('./shared_constants.js');
let _excelSyncEngine = null;
function getExcelSyncEngine() {
  if (!_excelSyncEngine) {
    _excelSyncEngine = require('./excel_sync_engine.js');
  }
  return _excelSyncEngine;
}

const PROD_SECTION_KEYS = new Set((PRODUCTION_SECTIONS || []).map(s => String(s).trim().toLowerCase()));

const app = express();
app.set('trust proxy', 1);

// Zero-I/O liveness/readiness endpoint for Cloud Run / ai.studio health probes
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Security Headers (OWASP Hardening; allow iframe embedding in AI Studio preview)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
const PORT = Number(process.env.PORT) || 3000;
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.STRICT_SESSION_SECRET === 'true') {
    throw new Error('FATAL: SESSION_SECRET environment variable is required in production environment. A consistent secret across all instances is mandatory.');
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    // Derive a stable 64-char secret per Cloud Run service when SESSION_SECRET is not injected (e.g. ai.studio publish)
    const serviceSeed = [
      process.env.K_SERVICE || 'iluo-skill-portal',
      process.env.UPSTASH_REDIS_REST_TOKEN || '',
      process.env.ADMIN_PASSWORD || '',
      'yokohama-iluo-session-v1'
    ].join(':');
    SESSION_SECRET = crypto.createHash('sha256').update(serviceSeed).digest('hex');
    console.warn('⚠️ WARNING: SESSION_SECRET env var not set in production; using derived fallback secret. Set SESSION_SECRET for multi-revision persistence.');
  } else {
    SESSION_SECRET = 'dev_ephemeral_session_secret_for_local_testing_only';
  }
  process.env.SESSION_SECRET = SESSION_SECRET;
}
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// Upstash Redis KV Configuration
let rawKvUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/['"]/g, '').trim();
if (rawKvUrl.includes('http')) {
  rawKvUrl = rawKvUrl.substring(rawKvUrl.indexOf('http')).trim();
}
const kvUrl = rawKvUrl.replace(/[\r\n\t]/g, '');

let rawKvToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').replace(/['"]/g, '').trim();
if (rawKvToken.includes('\t')) {
  rawKvToken = rawKvToken.split('\t').pop().trim();
}
rawKvToken = rawKvToken.replace(/^(?:UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN)\s*=\s*/i, '').trim();
const kvToken = rawKvToken.replace(/^(?:REST_)?TOKEN[\s\t]+/, '').replace(/[\r\n\t\s]/g, '');

if (isProduction && (!kvUrl || !kvToken)) {
  console.warn('⚠️ WARNING: Upstash Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) is not configured in production.');
}

// =========================================================================
// DISTRIBUTED RATE LIMITER & BRUTE-FORCE DEFENSE (Upstash Redis + Fail-Closed)
// =========================================================================
const memoryRateCounters = new Map();
const memoryRateLockouts = new Map();
let isKvWriteForbidden = false;

// Atomic Lua script executed inside Redis:
// KEYS[1]: rl:cnt:<key>
// KEYS[2]: rl:lock:<key>
// ARGV[1]: windowSec (TTL for counter window in seconds)
// ARGV[2]: maxAttempts (threshold count)
// ARGV[3]: lockoutSec (lockout duration in seconds)
const LUA_ATOMIC_RATE_LIMIT = `
local lockTtl = redis.call('TTL', KEYS[2])
if lockTtl > 0 then
  return lockTtl
end
local cnt = redis.call('INCR', KEYS[1])
if cnt == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
else
  local currentTtl = redis.call('TTL', KEYS[1])
  if currentTtl < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
end
if cnt >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return tonumber(ARGV[3])
end
return 0
`;

async function callCloudKvCommand(commandArray) {
  if (!kvUrl || !kvToken) {
    const err = new Error('Upstash Redis credentials missing');
    err.code = 'REDIS_MISSING_CREDENTIALS';
    throw err;
  }
  const isWriteCommand = commandArray && ['SET', 'INCR', 'DEL', 'EXPIRE', 'EVAL'].includes(commandArray[0]);
  if (isWriteCommand && isKvWriteForbidden) {
    const err = new Error('Upstash Redis write access forbidden (NOPERM)');
    err.code = 'REDIS_FORBIDDEN';
    throw err;
  }

  const resp = await fetch(kvUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kvToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandArray)
  });

  if (!resp.ok) {
    if (resp.status === 403 && isWriteCommand && process.env.FAIL_CLOSED_AUTH === 'true') {
      isKvWriteForbidden = true;
    }
    const err = new Error(`Redis HTTP error: ${resp.status}`);
    err.status = resp.status;
    err.code = resp.status === 403 ? 'REDIS_FORBIDDEN' : 'REDIS_HTTP_ERROR';
    throw err;
  }

  const data = await resp.json();
  if (data && data.error) {
    if (typeof data.error === 'string' && data.error.includes('NOPERM') && isWriteCommand && process.env.FAIL_CLOSED_AUTH === 'true') {
      isKvWriteForbidden = true;
    }
    const err = new Error(`Redis error: ${data.error}`);
    err.code = 'REDIS_COMMAND_ERROR';
    throw err;
  }

  return data ? data.result : null;
}

async function isRateKeyLocked(key) {
  const now = Date.now();
  let redisCheckFailed = false;
  let redisError = null;

  // 1. Check Redis if credentials configured
  if (kvUrl && kvToken) {
    try {
      const ttl = await callCloudKvCommand(['TTL', 'rl:lock:' + key]);
      if (typeof ttl === 'number') {
        if (ttl > 0) return ttl;
        if (ttl === -1) return 900; // Key exists without TTL, assume locked
      }
    } catch (e) {
      redisCheckFailed = true;
      redisError = e;
    }
  } else {
    redisCheckFailed = true;
    redisError = new Error('Redis not configured');
  }

  // Fail-closed in production only when Redis write is explicitly forbidden or strict auth fail-closed is enabled
  if (process.env.NODE_ENV === 'production' && (isKvWriteForbidden || process.env.FAIL_CLOSED_AUTH === 'true')) {
    if (redisCheckFailed) {
      throw redisError || new Error('Production rate limiter check unavailable');
    }
    return 0;
  }

  // 2. Check local fail-safe memory store (development/test only)
  const lockedUntil = memoryRateLockouts.get(key);
  if (lockedUntil && now < lockedUntil) {
    return Math.ceil((lockedUntil - now) / 1000);
  }
  if (lockedUntil && now >= lockedUntil) {
    memoryRateLockouts.delete(key);
  }
  return 0;
}

async function recordRateFailureOnKey(key, maxAttempts, windowSec, lockoutSec) {
  const now = Date.now();
  let lockedSeconds = 0;
  let redisSuccess = false;
  let redisError = null;

  // 1. Upstash Redis Atomic Lua Execution (INCR + EXPIRE + LOCK + DEL)
  if (kvUrl && kvToken) {
    try {
      const res = await callCloudKvCommand([
        'EVAL',
        LUA_ATOMIC_RATE_LIMIT,
        '2',
        'rl:cnt:' + key,
        'rl:lock:' + key,
        String(windowSec),
        String(maxAttempts),
        String(lockoutSec)
      ]);
      const resNum = Number(res);
      if (!isNaN(resNum)) {
        redisSuccess = true;
        lockedSeconds = resNum;
      }
    } catch (e) {
      redisSuccess = false;
      redisError = e;
    }
  } else {
    redisError = new Error('Redis not configured');
  }

  // Fail-closed in production only if Redis write is explicitly forbidden (test or strict fail-closed mode)
  if (process.env.NODE_ENV === 'production' && (isKvWriteForbidden || process.env.FAIL_CLOSED_AUTH === 'true') && !redisSuccess) {
    throw redisError || new Error('Production rate limiter record failure unavailable');
  }

  // 2. Fail-safe memory fallback (development/test only)
  if (!redisSuccess) {
    let rec = memoryRateCounters.get(key);
    if (!rec || now > rec.expiresAt) {
      rec = { count: 0, expiresAt: now + (windowSec * 1000) };
    }
    rec.count += 1;
    memoryRateCounters.set(key, rec);

    if (rec.count >= maxAttempts) {
      memoryRateLockouts.set(key, now + (lockoutSec * 1000));
      memoryRateCounters.delete(key);
      lockedSeconds = lockoutSec;
    }
  }

  return lockedSeconds;
}

async function clearRateAccountSuccess(accountKey) {
  if (!accountKey) return;
  // Clear in Redis (Atomic multi-key DEL)
  if (kvUrl && kvToken) {
    try {
      await callCloudKvCommand(['DEL', 'rl:cnt:' + accountKey, 'rl:lock:' + accountKey]);
    } catch (e) {}
  }
  // Clear in local memory fallback
  memoryRateCounters.delete(accountKey);
  memoryRateLockouts.delete(accountKey);
}

async function handleAuthFailure(req, res, defaultStatus = 401, defaultMessage = 'Invalid credentials') {
  if (req.recordAuthFailure) {
    try {
      await req.recordAuthFailure();
    } catch (rateErr) {
      if (isKvWriteForbidden || (rateErr && rateErr.status === 503) || process.env.FAIL_CLOSED_AUTH === 'true') {
        return res.status(503).json({
          success: false,
          message: 'Authentication service temporarily unavailable. Security controls offline.',
          code: 'AUTH_RATE_LIMIT_UNAVAILABLE'
        });
      }
    }
  }
  const actor = (req.body && (req.body.empNo || req.body.username || req.body.email || req.body.section || req.body.department)) || 'anonymous';
  try {
    await logAuditEvent('LOGIN_FAILED', String(actor), `Failed authentication on ${req.path}`, req);
  } catch (e) {}
  return res.status(defaultStatus).json({ success: false, message: defaultMessage });
}

function authRateLimiter(options = {}) {
  const accountMax = options.accountMax || 5;    // Max 5 failed attempts per account
  const ipMax = options.ipMax || 20;            // Max 20 failed attempts per IP
  const windowSec = options.windowSec || 600;   // 10 minute failure window
  const lockoutSec = options.lockoutSec || 900; // 15 minute temporary lockout

  return async (req, res, next) => {
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
    const cleanIp = String(rawIp).replace(/[^a-zA-Z0-9_\-.:]/g, '_');
    const ipKey = 'ip:' + cleanIp;

    const rawAccount = req.body.empNo || req.body.username || req.body.email || req.body.section || req.body.dept || req.body.evaluatorName || '';
    const cleanAccount = String(rawAccount).toLowerCase().trim().replace(/[^a-zA-Z0-9_\-@.]/g, '_');
    const accountKey = cleanAccount ? 'acc:' + cleanAccount : null;

    // Fail-closed production enforcement: If write access is explicitly forbidden (test simulation or strict fail-closed mode)
    if (process.env.NODE_ENV === 'production' && (isKvWriteForbidden || (process.env.FAIL_CLOSED_AUTH === 'true' && (!kvUrl || !kvToken)))) {
      console.error('[SECURITY ERROR] Production authentication blocked: Redis rate limiter unavailable or write forbidden.');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable. Security controls offline.',
        code: 'AUTH_RATE_LIMIT_UNAVAILABLE'
      });
    }

    // Pre-check lockouts
    try {
      const ipRetryAfter = await isRateKeyLocked(ipKey);
      if (ipRetryAfter > 0) {
        res.setHeader('Retry-After', String(ipRetryAfter));
        return res.status(429).json({
          success: false,
          message: `Too many failed login attempts from this IP address. Temporarily locked out. Try again in ${ipRetryAfter} seconds.`,
          retryAfter: ipRetryAfter
        });
      }

      if (accountKey) {
        const accRetryAfter = await isRateKeyLocked(accountKey);
        if (accRetryAfter > 0) {
          res.setHeader('Retry-After', String(accRetryAfter));
          return res.status(429).json({
            success: false,
            message: `Too many failed login attempts for this account. Temporarily locked out. Try again in ${accRetryAfter} seconds.`,
            retryAfter: accRetryAfter
          });
        }
      }
    } catch (err) {
      if (process.env.NODE_ENV === 'production') {
        console.error(`[SECURITY ERROR] Production rate limit pre-check failed: ${err.message}`);
        return res.status(503).json({
          success: false,
          message: 'Authentication service temporarily unavailable. Security controls offline.',
          code: 'AUTH_RATE_LIMIT_UNAVAILABLE'
        });
      }
    }

    req.recordAuthFailure = async () => {
      try {
        await recordRateFailureOnKey(ipKey, ipMax, windowSec, lockoutSec);
        if (accountKey) {
          await recordRateFailureOnKey(accountKey, accountMax, windowSec, lockoutSec);
        }
      } catch (err) {
        if (process.env.NODE_ENV === 'production' && (isKvWriteForbidden || process.env.FAIL_CLOSED_AUTH === 'true')) {
          console.error(`[SECURITY ERROR] Production rate limit write failed: ${err.message}`);
          const secErr = new Error('Rate limit record failure in production');
          secErr.status = 503;
          secErr.code = 'AUTH_RATE_LIMIT_UNAVAILABLE';
          throw secErr;
        }
      }
    };

    req.recordAuthSuccess = async () => {
      // NOTE: Only clears the account counter, intentionally keeping IP failure counter intact
      // to prevent an attacker using one valid credential from clearing IP rate limits!
      if (accountKey) {
        try {
          await clearRateAccountSuccess(accountKey);
        } catch (e) {}
      }
    };

    next();
  };
}

// Session Cookie Names Audited Across Entire Application
const SESSION_COOKIE_NAMES = [
  'admin_session',
  'emp_session',
  'evaluator_session',
  'section_session',
  'dept_session',
  'yokohama_session'
];

function hasAuthenticatedSessionCookie(req) {
  const signed = req.signedCookies || {};
  const unsigned = req.cookies || {};
  for (const name of SESSION_COOKIE_NAMES) {
    if (signed[name] || unsigned[name]) return true;
  }
  return false;
}

const AUTHORIZED_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

// Strict Trusted Origins Allowlist
const CONFIGURED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5000',
  ...CONFIGURED_ORIGINS
];

if (process.env.MANAGEMENT_PORTAL_URL) ALLOWED_ORIGINS.push(process.env.MANAGEMENT_PORTAL_URL.trim());
if (process.env.EMPLOYEE_PORTAL_URL) ALLOWED_ORIGINS.push(process.env.EMPLOYEE_PORTAL_URL.trim());

function isOriginAllowed(origin, req = null) {
  if (!origin) return true; // Same-origin direct requests (no Origin header) are always permitted
  try {
    const u = new URL(origin);
    const hostOrigin = u.origin.toLowerCase();
    if (ALLOWED_ORIGINS.some(o => o.toLowerCase() === hostOrigin)) return true;
    if (req) {
      const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
      if (reqHost && u.host.toLowerCase() === reqHost) return true;
    }
    if (hostOrigin.endsWith('.run.app')) return true;
    if (hostOrigin.endsWith('.vercel.app') && (hostOrigin.includes('yokohama-iluo') || hostOrigin.includes('iluo-employee') || hostOrigin.includes('iluo-management'))) return true;
    if (hostOrigin.endsWith('.yourdomain.in')) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostOrigin)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function isHttpsRequest(req) {
  if (!req) return false;
  return !!(req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https'));
}

app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  if (!origin || isOriginAllowed(origin, req)) {
    callback(null, { origin: true, credentials: true });
  } else {
    callback(new Error('Blocked by CORS policy'));
  }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser(SESSION_SECRET));

// Standard Secure Cookie Options Helper
function getCookieOptions(maxAgeMs = 8 * 60 * 60 * 1000, req = null) {
  const isHttps = isHttpsRequest(req);
  return {
    httpOnly: true,
    secure: isProduction || isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    maxAge: maxAgeMs,
    path: '/',
    signed: true
  };
}

// CSRF & Untrusted Origin Blocker - STRICT FAIL-CLOSED (OWASP A01 / CSRF Defense)
app.use((req, res, next) => {
  const isHttps = isHttpsRequest(req);
  // Safe read requests (GET, HEAD, OPTIONS): initialize or refresh double-submit CSRF cookies
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let secret = req.cookies ? req.cookies['_csrf_secret'] : null;
    let token = req.cookies ? req.cookies['XSRF-TOKEN'] : null;

    if (!secret) {
      try {
        secret = csrfTokens.secretSync();
        res.cookie('_csrf_secret', secret, {
          httpOnly: true,
          sameSite: isHttps ? 'none' : 'lax',
          secure: isProduction || isHttps,
          path: '/'
        });
      } catch (err) {
        console.error('CSRF secret generation failed:', err.message);
      }
    }

    if (secret && (!token || !csrfTokens.verify(secret, token))) {
      try {
        token = csrfTokens.create(secret);
        res.cookie('XSRF-TOKEN', token, {
          httpOnly: false, // Must be readable by client JavaScript for double-submit header
          sameSite: isHttps ? 'none' : 'lax',
          secure: isProduction || isHttps,
          path: '/'
        });
      } catch (err) {
        console.error('CSRF token creation failed:', err.message);
      }
    }

    return next();
  }

  // 1. Strict Origin & Referer Verification against trusted allowlist
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  if (origin) {
    if (!isOriginAllowed(origin, req)) {
      return res.status(403).json({ success: false, message: 'Forbidden: CSRF check failed (Untrusted Origin)' });
    }
  } else if (referer) {
    if (!isOriginAllowed(referer, req)) {
      return res.status(403).json({ success: false, message: 'Forbidden: CSRF check failed (Untrusted Referer)' });
    }
  }

  // 2. Strict Fail-Closed Check for Cookie-Authenticated Requests:
  // If ANY session cookie is present, ambient authority is in use.
  // CSRF validation MUST be enforced; having custom headers does NOT bypass it!
  // Note: Initial login/password setup endpoints are unauthenticated credential submissions.
  const isAuthLoginRoute = req.path.startsWith('/api/auth/') && (
    req.path.includes('/login') ||
    req.path.includes('/admin/send-otp') ||
    req.path.includes('/admin/verify-otp')
  );

  const hasCookieSession = hasAuthenticatedSessionCookie(req);

  if (hasCookieSession && !isAuthLoginRoute) {
    const token = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || (req.body && req.body._csrf);
    const secret = req.cookies ? req.cookies['_csrf_secret'] : null;

    if (!token) {
      return res.status(403).json({ success: false, message: 'Forbidden: CSRF token missing' });
    }
    if (!secret) {
      return res.status(403).json({ success: false, message: 'Forbidden: CSRF session secret missing' });
    }
    if (!csrfTokens.verify(secret, token)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Invalid CSRF token' });
    }
  }

  next();
});

// Dedicated endpoint to fetch fresh CSRF token
app.get('/api/csrf-token', (req, res) => {
  const isHttps = isHttpsRequest(req);
  let secret = req.cookies ? req.cookies['_csrf_secret'] : null;
  if (!secret) {
    secret = csrfTokens.secretSync();
    res.cookie('_csrf_secret', secret, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isProduction || isHttps,
      path: '/'
    });
  }
  const token = csrfTokens.create(secret);
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isProduction || isHttps,
    path: '/'
  });
  res.json({ success: true, csrfToken: token });
});

// Health & Upstash Redis Database Connectivity Check (never exposes secrets)
app.get('/api/health', async (req, res) => {
  const configured = Boolean(kvUrl && kvToken);
  if (!configured) {
    return res.json({
      ok: true,
      database: {
        provider: 'local-memory',
        configured: false,
        connected: false
      }
    });
  }
  const startedAt = Date.now();
  try {
    const pingRes = await callCloudKvCommand(['PING']);
    const latencyMs = Date.now() - startedAt;
    const connected = pingRes === 'PONG';
    if (connected && !upstashSeedCompleted && !upstashReadOnlyDetected) {
      ensureUpstashInitialSeed().catch(() => {});
    }
    const writable = connected && !upstashReadOnlyDetected;
    return res.json({
      ok: true,
      database: {
        provider: 'upstash-redis',
        configured: true,
        connected,
        writable,
        latencyMs,
        seeded: upstashSeedCompleted,
        ...(upstashSeedRetryTimer && !upstashSeedCompleted ? { seedRetrying: true, seedAttempts: upstashSeedAttempts } : {}),
        ...(upstashReadOnlyDetected ? { warning: 'Read-only Upstash token detected (NOPERM). Configure the primary Read-Write UPSTASH_REDIS_REST_TOKEN.' } : {}),
        ...(!upstashSeedCompleted && upstashLastSeedError ? { seedError: upstashLastSeedError } : {})
      }
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      database: {
        provider: 'upstash-redis',
        configured: true,
        connected: false,
        latencyMs: Date.now() - startedAt,
        error: err ? err.message : 'Redis ping failed'
      }
    });
  }
});

// Strict Allowlist of Public Static Assets
const ALLOWED_STATIC_FILES = new Set([
  '/',
  '/index.html',
  '/employee',
  '/employee/',
  '/employee.html',
  '/employee.js',
  '/management',
  '/management/',
  '/app.js',
  '/data.js',
  '/shared_constants.js',
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
  '/favicon.png',
  '/manifest.json'
]);

const STATIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : __dirname;

// Regex matching explicitly forbidden internal/source files (returns 403 Forbidden)
const FORBIDDEN_FILE_PATTERN = /^(?:\/\.env|\/tests\/|\/docs\/|\/\.superpowers\/|.*(?:\.(?:json|lock|md|ps1|bat|sh|py|yaml|yml|log|dockerignore)|Dockerfile|Procfile|package\.json|package-lock\.json|server\.js|excel_sync_engine\.js|build\.js)$)/i;

// Static Security Middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  const decodedPath = decodeURIComponent(req.path);

  // 1. Explicitly block sensitive backend code, data stores, tests, configs, and env files
  if (FORBIDDEN_FILE_PATTERN.test(req.path) || FORBIDDEN_FILE_PATTERN.test(decodedPath)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Direct access to this resource is restricted by static security policy'
    });
  }

  // 2. Allow official Word templates in QC_templates
  if (req.path.startsWith('/QC_templates/') && req.path.endsWith('.docx')) {
    return next();
  }

  // 3. Allow static images in /assets/
  if (req.path.startsWith('/assets/') && /\.(png|jpe?g|svg|ico|webp)$/i.test(req.path)) {
    return next();
  }

  // 4. Allow public static assets from allowlist
  if (ALLOWED_STATIC_FILES.has(req.path) || ALLOWED_STATIC_FILES.has(decodedPath)) {
    return next();
  }

  // 5. If it looks like a file with an extension, reject with 404 (not found)
  if (/\.[a-zA-Z0-9]+$/i.test(req.path)) {
    return res.status(404).json({
      success: false,
      error: 'Not Found'
    });
  }

  // 6. Otherwise it is an SPA navigation path (e.g. /secure-control/dashboard, /section, /ojt-login)
  return next();
});

// Portal routing resolver: Determines whether to serve Employee Portal vs Management Portal
function isEmployeePortalRequest(req) {
  if (process.env.APP_TARGET === 'employee') return true;
  if (process.env.APP_TARGET === 'management') return false;

  const p = (req.path || '').toLowerCase();
  if (p === '/employee' || p.startsWith('/employee/')) return true;

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (host.includes('employee')) {
    return true;
  }
  return false;
}

// Explicit root and portal routes
app.get(['/', '/index.html'], (req, res) => {
  if (isEmployeePortalRequest(req)) {
    return res.sendFile(path.join(STATIC_DIR, 'employee.html'));
  }
  return res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.get(['/employee', '/employee.html'], (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'employee.html'));
});

app.get(['/management', '/management.html'], (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// Auth-protected Master Excel route BEFORE express.static so direct XLSX filename cannot bypass RBAC
app.get(['/api/download-master-excel', '/1. PRODUCTION SKILL ASSESSMENT DATA 30.06.2026.xlsx', encodeURI('/1. PRODUCTION SKILL ASSESSMENT DATA 30.06.2026.xlsx')], async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required for master workbook export' });
  }
  if (!['SUPERADMIN', 'ADMIN', 'DEPT_HEAD', 'SECTION_HEAD'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Management privileges required for master Excel export' });
  }
  await logAuditEvent('EXPORT_MASTER_EXCEL', user, 'Downloaded template-cloned Master Production & QA Excel workbook', req);

  const dateStamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="1. PRODUCTION SKILL ASSESSMENT DATA ${dateStamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  try {
    const [employees, records, ojtRecords] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);
    const outBuf = await getExcelSyncEngine().exportProductionWorkbookBuffer(employees, records, ojtRecords);
    res.setHeader('Content-Length', outBuf.length);
    return res.end(outBuf);
  } catch (err) {
    console.error('[EXPORT MASTER EXCEL ERROR]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate master Production Excel workbook' });
  }
});

// Exact Template-Matching Production Excel Export (All 6 sheets, formulas, chart, styles preserved)
app.get('/api/export/production-excel', async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required for Production Excel export' });
  }
  if (!['SUPERADMIN', 'ADMIN', 'DEPT_HEAD', 'SECTION_HEAD'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Management privileges required for Production Excel export' });
  }

  try {
    const [employees, records, ojtRecords] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);
    const outBuf = await getExcelSyncEngine().exportProductionWorkbookBuffer(employees, records, ojtRecords);
    const dateStamp = new Date().toISOString().slice(0, 10);
    await logAuditEvent('EXPORT_PRODUCTION_EXCEL', user, `Exported template-cloned Production Excel workbook (${dateStamp})`, req);
    res.setHeader('Content-Disposition', `attachment; filename="1. PRODUCTION SKILL ASSESSMENT DATA ${dateStamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', outBuf.length);
    return res.end(outBuf);
  } catch (err) {
    console.error('[EXPORT PRODUCTION EXCEL ERROR]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to export Production Excel workbook' });
  }
});

// Exact Template-Matching QA Excel Export (All 5 sheets, hidden states, formulas, styles preserved)
app.get('/api/export/qa-excel', async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required for QA Excel export' });
  }
  if (!['SUPERADMIN', 'ADMIN', 'DEPT_HEAD', 'SECTION_HEAD'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Management privileges required for QA Excel export' });
  }

  try {
    const [employees, records, ojtRecords] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);
    const outBuf = await getExcelSyncEngine().exportQaWorkbookBuffer(employees, records, ojtRecords);
    const dateStamp = new Date().toISOString().slice(0, 10);
    await logAuditEvent('EXPORT_QA_EXCEL', user, `Exported template-cloned QA Excel workbook (${dateStamp})`, req);
    res.setHeader('Content-Disposition', `attachment; filename="QA_Workman_name_list_${dateStamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', outBuf.length);
    return res.end(outBuf);
  } catch (err) {
    console.error('[EXPORT QA EXCEL ERROR]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to export QA Excel workbook' });
  }
});

// Section-Wise Completion Summary Builder & Executive PDF Export (Production / QA / All)
function buildSectionSummaryReportData(employees, records, ojtRecords, rawScope = 'PRODUCTION') {
  const scopeNorm = String(rawScope || 'PRODUCTION').trim().toUpperCase();
  const scope = (scopeNorm === 'QA' || scopeNorm === 'QUALITY CONTROL' || scopeNorm === 'QC')
    ? 'QA'
    : (scopeNorm === 'ALL' || scopeNorm === 'PLANT')
      ? 'ALL'
      : 'PRODUCTION';

  const allEmps = Array.isArray(employees) ? employees : [];
  const recMap = records && typeof records === 'object' ? records : {};
  const ojtMap = ojtRecords && typeof ojtRecords === 'object' ? ojtRecords : {};

  let leftCount = 0;
  const activeEmps = [];
  allEmps.forEach((emp) => {
    const isLeft = Boolean(emp && (emp.isLeft || emp.status === 'LEFT'));
    const empDept = normalizeDepartmentName(emp && emp.dept);
    const matchesScope =
      scope === 'ALL' ||
      (scope === 'PRODUCTION' && empDept === 'PRODUCTION') ||
      (scope === 'QA' && empDept !== 'PRODUCTION');
    if (isLeft) {
      if (matchesScope) leftCount++;
      return;
    }
    if (matchesScope) activeEmps.push(emp);
  });

  const sectionsList = [];
  const pushSectionStats = (name, deptGroup, empsInSec) => {
    let examDone = 0;
    let examPassed = 0;
    let ojtDone = 0;
    let ojtPassed = 0;
    let bothDone = 0;
    let bothPassed = 0;

    empsInSec.forEach((emp) => {
      const rec = recMap[emp.empNo];
      const ojt = ojtMap[emp.empNo];
      const hasExam = Boolean(rec && rec.isCompleted);
      const isExamPass = hasExam && (
        rec.status === 'Passed' ||
        rec.questStatus === 'Pass' ||
        (rec.markPct !== undefined && Number(rec.markPct) >= 50)
      );
      const hasOjt = Boolean(ojt && (ojt.totalScore !== undefined || ojt.scorePct !== undefined));
      const isOjtPass = hasOjt && (
        ojt.qualificationStatus === 'Qualified' ||
        ojt.result === 'Pass' ||
        ojt.status === 'Pass' ||
        (ojt.scorePct !== undefined && Number(ojt.scorePct) >= 70)
      );

      if (hasExam) {
        examDone++;
        if (isExamPass) examPassed++;
      }
      if (hasOjt) {
        ojtDone++;
        if (isOjtPass) ojtPassed++;
      }
      if (hasExam && hasOjt) {
        bothDone++;
        if (isExamPass && isOjtPass) bothPassed++;
      }
    });

    const total = empsInSec.length;
    sectionsList.push({
      name,
      deptGroup,
      total,
      examDone,
      examPassed,
      ojtDone,
      ojtPassed,
      bothDone,
      bothPassed,
      pending: Math.max(0, total - bothDone),
      completionPct: total > 0 ? Math.round((bothDone / total) * 100) : 0
    });
  };

  if (scope === 'PRODUCTION' || scope === 'ALL') {
    const prodEmps = activeEmps.filter((e) => normalizeDepartmentName(e.dept) === 'PRODUCTION');
    const byProdSec = new Map();
    prodEmps.forEach((emp) => {
      const rawName = String(emp.section || 'UNASSIGNED').trim().replace(/\s+/g, ' ').toUpperCase();
      if (!byProdSec.has(rawName)) byProdSec.set(rawName, []);
      byProdSec.get(rawName).push(emp);
    });

    const orderedNames = [];
    const seen = new Set();
    (PRODUCTION_SECTIONS || []).forEach((sName) => {
      const key = String(sName).trim().toUpperCase();
      orderedNames.push(key);
      seen.add(key);
    });
    Array.from(byProdSec.keys()).sort().forEach((k) => {
      if (!seen.has(k)) orderedNames.push(k);
    });

    orderedNames.forEach((secName) => {
      const list = byProdSec.get(secName) || [];
      if (list.length > 0 || PROD_SECTION_KEYS.has(secName.toLowerCase())) {
        pushSectionStats(secName, 'PRODUCTION', list);
      }
    });
  }

  if (scope === 'QA' || scope === 'ALL') {
    const qaEmps = activeEmps.filter((e) => normalizeDepartmentName(e.dept) !== 'PRODUCTION');
    (QA_SECTIONS || []).forEach((qaSec) => {
      const normKey = normalizeQaSectionKey(qaSec.name);
      const list = qaEmps.filter((e) => normalizeQaSectionKey(e.section) === normKey);
      pushSectionStats(qaSec.name, 'QUALITY CONTROL', list);
    });
  }

  const levelBreakdown = { I: 0, L: 0, U: 0, O: 0 };
  activeEmps.forEach((emp) => {
    const lvl = String(emp.currentLevel || 'I').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(levelBreakdown, lvl)) {
      levelBreakdown[lvl]++;
    } else {
      levelBreakdown.I++;
    }
  });

  const totals = sectionsList.reduce((acc, s) => {
    acc.total += s.total;
    acc.examDone += s.examDone;
    acc.examPassed += s.examPassed;
    acc.ojtDone += s.ojtDone;
    acc.ojtPassed += s.ojtPassed;
    acc.bothDone += s.bothDone;
    acc.bothPassed += s.bothPassed;
    acc.pending += s.pending;
    return acc;
  }, { total: 0, examDone: 0, examPassed: 0, ojtDone: 0, ojtPassed: 0, bothDone: 0, bothPassed: 0, pending: 0, completionPct: 0 });
  totals.completionPct = totals.total > 0 ? Math.round((totals.bothDone / totals.total) * 100) : 0;

  const departmentLabel = scope === 'QA'
    ? 'Quality Control (8 QA Sections)'
    : scope === 'ALL'
      ? 'Plant-Wide Summary (Production & Quality Control)'
      : `Production Department (${sectionsList.length} Sections)`;

  return {
    scope,
    departmentLabel,
    sections: sectionsList,
    totals,
    levelBreakdown,
    leftCount
  };
}

app.get('/api/export/section-summary-pdf', async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Authentication required for Summary PDF export' });
  }
  if (!['SUPERADMIN', 'ADMIN', 'DEPT_HEAD', 'SECTION_HEAD'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Management privileges required for Summary PDF export' });
  }

  let requestedScope = String(req.query.scope || req.query.dept || 'PRODUCTION').toUpperCase();
  if (user.role === 'DEPT_HEAD' && user.department) {
    requestedScope = normalizeDepartmentName(user.department) === 'PRODUCTION' ? 'PRODUCTION' : 'QA';
  } else if (user.role === 'SECTION_HEAD') {
    requestedScope = 'QA';
  }

  try {
    const [employees, records, ojtRecords] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);

    const summaryData = buildSectionSummaryReportData(employees, records, ojtRecords, requestedScope);
    const html = generateSectionSummaryReportHtml({
      ...summaryData,
      logoBase64: getLogoBase64()
    });
    const pdfBuf = await renderHtmlToPdf(html);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const fileScopeSlug = summaryData.scope === 'QA' ? 'QA' : summaryData.scope === 'ALL' ? 'Plant_Wide' : 'Production';
    const fileName = `Yokohama_${fileScopeSlug}_Section_Summary_${dateStamp}.pdf`;

    await logAuditEvent('EXPORT_SECTION_SUMMARY_PDF', user, `Exported ${fileScopeSlug} Section Summary PDF (${dateStamp})`, req, fileScopeSlug);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    return res.send(pdfBuf);
  } catch (err) {
    console.error('[EXPORT SECTION SUMMARY PDF ERROR]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to export Section Completion Summary PDF' });
  }
});

// Explicit static route for QC_templates Word files & assets
app.use('/QC_templates', express.static(path.join(STATIC_DIR, 'QC_templates')));
app.use('/assets', express.static(path.join(STATIC_DIR, 'assets')));
app.use('/public', express.static(path.join(STATIC_DIR, 'public')));
app.use(express.static(STATIC_DIR, { dotfiles: 'ignore', index: false }));

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

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: "Yokohama ILUO Skill Assessment",
    short_name: "Yokohama ILUO",
    description: "Official Plant Skill Qualification & Analytics Portal for Yokohama ATC Tires",
    start_url: "/",
    display: "standalone",
    background_color: "#0B1120",
    theme_color: "#005B9E",
    orientation: "portrait-primary",
    icons: [
      {
        src: "atg_logo.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable"
      },
      {
        src: "atg_logo.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable"
      }
    ]
  });
});

// Function to update Master Excel workbook with live candidate exam marks & OJT records
function updateMasterWorkbookWithRecords(wb, records, ojtRecords, employees) {
  if (!wb || !records) return;

  const nl = wb.Sheets['Name list'];
  const es = wb.Sheets['Entry sheet'];

  const recMap = new Map();
  Object.entries(records).forEach(([empNo, rec]) => {
    if (rec && rec.isCompleted) {
      recMap.set(String(empNo).trim().toLowerCase(), rec);
    }
  });

  const ojtMap = new Map();
  if (ojtRecords) {
    Object.entries(ojtRecords).forEach(([empNo, ojt]) => {
      ojtMap.set(String(empNo).trim().toLowerCase(), ojt);
    });
  }

  function getCategoryMarks(rec) {
    let s = rec.safetyMark !== undefined ? rec.safetyMark : null;
    let p = rec.processMark !== undefined ? rec.processMark : null;
    let ci = rec.ciTpmMark !== undefined ? rec.ciTpmMark : null;
    let q = rec.qualityMark !== undefined ? rec.qualityMark : null;

    if (s === null && Array.isArray(rec.submittedQuestions) && rec.submittedQuestions.length > 0) {
      let cs = 0, cci = 0, cp = 0, cq = 0;
      rec.submittedQuestions.forEach(item => {
        if (!item.isCorrect) return;
        const cat = (item.category || '').toLowerCase();
        if (cat.includes('safety')) cs++;
        else if (cat.includes('ci') || cat.includes('tpm')) cci++;
        else if (cat.includes('quality')) cq++;
        else cp++;
      });
      s = cs;
      ci = cci;
      p = cp;
      q = cq;
    } else if (s === null && rec.totalMark > 0) {
      const tm = rec.totalMark;
      s = Math.min(10, Math.floor(tm * 0.25));
      p = Math.min(10, Math.floor(tm * 0.25));
      q = Math.min(10, Math.floor(tm * 0.25));
      ci = Math.max(0, tm - s - p - q);
    }
    return { s, p, q, ci };
  }

  // 1. Update Name list (Columns J: Safety, K: Process, L: Quality, M: CI & TPM, O: Knowledge Mark, P: %, Q: Result)
  if (nl) {
    for (let r = 3; r <= 2000; r++) {
      const cellB = nl['B' + r];
      if (!cellB) continue;
      const empNoKey = String(cellB.v || '').trim().toLowerCase();
      const rec = recMap.get(empNoKey);
      if (!rec) continue;

      const marks = getCategoryMarks(rec);
      if (marks.s !== null) nl['J' + r] = { t: 'n', v: marks.s };
      if (marks.p !== null) nl['K' + r] = { t: 'n', v: marks.p };
      if (marks.q !== null) nl['L' + r] = { t: 'n', v: marks.q };
      if (marks.ci !== null) nl['M' + r] = { t: 'n', v: marks.ci };
      if (rec.totalMark !== undefined) nl['O' + r] = { t: 'n', v: rec.totalMark, f: `SUM(J${r}:N${r})` };
      if (rec.markPct !== undefined) nl['P' + r] = { t: 'n', v: rec.markPct / 100, z: '0%' };
      if (rec.status) nl['Q' + r] = { t: 's', v: rec.status };

      const ojt = ojtMap.get(empNoKey);
      if (ojt && ojt.totalScore !== undefined) {
        nl['S' + r] = { t: 'n', v: parseInt(ojt.safetyScore || 15, 10) };
        nl['T' + r] = { t: 'n', v: parseInt(ojt.sopScore || 15, 10) };
        nl['U' + r] = { t: 'n', v: ojt.totalScore, f: `SUM(S${r}:T${r})` };
        nl['V' + r] = { t: 'n', v: (ojt.scorePct || 0) / 100, z: '0%' };
        nl['W' + r] = { t: 's', v: ojt.qualificationStatus || 'Qualified' };
      }
    }
  }

  // 2. Update Entry sheet (Column F: Safety, G: Process, H: Quality, I: CI & TPM, K: Gemba Safety/5S, L: Gemba SOP)
  if (es) {
    let entryRow = 3;
    recMap.forEach((rec, empNoKey) => {
      const emp = (employees || []).find(e => String(e.empNo).trim().toLowerCase() === empNoKey);
      const marks = getCategoryMarks(rec);
      const ojt = ojtMap.get(empNoKey);

      es['A' + entryRow] = { t: 'n', v: entryRow - 2 };
      es['B' + entryRow] = { t: 's', v: emp ? emp.empNo : rec.empNo };
      es['C' + entryRow] = { t: 's', v: emp ? emp.name : rec.name };
      es['D' + entryRow] = { t: 's', v: (emp ? emp.section : rec.section) || '' };
      es['E' + entryRow] = { t: 's', v: rec.targetLevel || (emp ? emp.currentLevel : 'L') };
      if (marks.s !== null) es['F' + entryRow] = { t: 'n', v: marks.s };
      if (marks.p !== null) es['G' + entryRow] = { t: 'n', v: marks.p };
      if (marks.q !== null) es['H' + entryRow] = { t: 'n', v: marks.q };
      if (marks.ci !== null) es['I' + entryRow] = { t: 'n', v: marks.ci };
      if (ojt && ojt.totalScore !== undefined) {
        es['K' + entryRow] = { t: 'n', v: parseInt(ojt.safetyScore || 15, 10) };
        es['L' + entryRow] = { t: 'n', v: parseInt(ojt.sopScore || 15, 10) };
      }
      entryRow++;
    });
    const maxR = Math.max(71, entryRow);
    es['!ref'] = `A1:L${maxR}`;
  }
}

// Master Excel route moved before express.static above to prevent unauthenticated direct file bypass.

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
      if (error) console.error('SMTP connection failed:', error ? error.message : '');
      else console.log('SMTP connection successful');
    });
  }
} else {
  console.warn('⚠️ SMTP_USER or SMTP_PASS environment variable is not configured. Email OTP dispatch will be unavailable.');
}

// ---------------------------------------------------------------------
// Cloud-Persisted Upstash Redis Helper (Single Source of Truth)
// ---------------------------------------------------------------------
const REDIS_KEYS = {
  employees: 'yokohama_employees',
  records: 'yokohama_records',
  ojt: 'yokohama_ojt',
  ojtLegacy: 'yokohama_ojt_evaluations',
  questions: 'yokohama_questions',
  questionsLegacy: 'yokohama_question_bank',
  settings: 'yokohama_settings'
};

let kvWriteDisabled = false;
let upstashSeedCompleted = false;
let upstashSeedPromise = null;
let upstashLastSeedError = null;
let upstashReadOnlyDetected = false;
let upstashLastSeedAttemptAt = 0;
let upstashSeedAttempts = 0;
let upstashSeedRetryTimer = null;

const UPSTASH_SEED_STEP_RETRIES = 3;
const UPSTASH_SEED_STARTUP_MAX_RETRIES = 5;
const UPSTASH_SEED_BASE_DELAY_MS = Number(process.env.UPSTASH_SEED_RETRY_BASE_MS) || 2000;

function isPermanentRedisAuthError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return err.status === 401 || err.status === 403 || err.code === 'REDIS_FORBIDDEN' ||
    msg.includes('401') || msg.includes('403') || msg.includes('NOPERM') || msg.includes('WRONGPASS');
}

function clearUpstashSeedRetryTimer() {
  if (upstashSeedRetryTimer) {
    clearTimeout(upstashSeedRetryTimer);
    upstashSeedRetryTimer = null;
  }
}

async function withUpstashStepRetry(stepName, fn, maxAttempts = UPSTASH_SEED_STEP_RETRIES) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isPermanentRedisAuthError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = Math.min(3000, 350 * Math.pow(2, attempt - 1));
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }
  throw lastErr;
}

const CLOUD_KV_GZIP_PREFIX = '__gz__:';
const CLOUD_KV_GZIP_THRESHOLD_BYTES = 65536;

function encodeCloudKvValue(value) {
  const valStr = JSON.stringify(value);
  if (Buffer.byteLength(valStr, 'utf8') > CLOUD_KV_GZIP_THRESHOLD_BYTES) {
    const compressed = zlib.gzipSync(Buffer.from(valStr, 'utf8')).toString('base64');
    return `${CLOUD_KV_GZIP_PREFIX}${compressed}`;
  }
  return valStr;
}

function decodeCloudKvValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith(CLOUD_KV_GZIP_PREFIX)) {
    const b64 = raw.slice(CLOUD_KV_GZIP_PREFIX.length);
    const inflated = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    return JSON.parse(inflated);
  }
  return JSON.parse(raw);
}

async function readSanitizedHttpError(resp) {
  let bodySnippet = '';
  try {
    const text = await resp.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) bodySnippet = String(parsed.error);
        else bodySnippet = text;
      } catch (e) {
        bodySnippet = text;
      }
    }
  } catch (e) {}
  bodySnippet = bodySnippet.replace(/\s+/g, ' ').trim().slice(0, 200);
  return bodySnippet
    ? `Redis HTTP error: ${resp.status} ${resp.statusText} (${bodySnippet})`
    : `Redis HTTP error: ${resp.status} ${resp.statusText}`;
}

function createRedisWriteError(key, cause) {
  const detail = cause && cause.message ? cause.message : String(cause || 'Unknown Redis write error');
  const err = new Error(`Cloud database write failed for ${key}: ${detail}`);
  err.statusCode = 503;
  err.code = 'REDIS_WRITE_FAILED';
  err.exposeMessage = true;
  return err;
}

async function syncWithCloudKv(action, key = REDIS_KEYS.records, value = null, ttlSeconds = null, options = {}) {
  const strict = Boolean(options && options.strict);
  if (!kvUrl || !kvToken) {
    if (isProduction && (action === 'SET' || action === 'DEL') && process.env.FAIL_CLOSED_STORAGE === 'true') {
      throw new Error(`Production storage configuration missing: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required to persist ${action} on ${key}`);
    }
    return null;
  }
  const isWriteAction = action === 'SET' || action === 'DEL';
  if (isWriteAction && kvWriteDisabled && !strict && !(isProduction && process.env.FAIL_CLOSED_STORAGE === 'true')) {
    return null;
  }
  const kvTimeoutSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(15000)
    : undefined;
  try {
    let resp;
    if (action === 'GET') {
      resp = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
        signal: kvTimeoutSignal
      });
      if (!resp.ok) {
        const err = new Error(await readSanitizedHttpError(resp));
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      if (data && data.error) {
        throw new Error(`Redis error: ${data.error}`);
      }
      if (data && data.result !== undefined && data.result !== null) {
        return decodeCloudKvValue(data.result);
      }
      return null;
    } else if (action === 'SET') {
      const valStr = encodeCloudKvValue(value);
      const command = ttlSeconds
        ? ['SET', key, valStr, 'EX', String(ttlSeconds)]
        : ['SET', key, valStr];
      resp = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command),
        signal: kvTimeoutSignal
      });
      if (!resp.ok) {
        const err = new Error(await readSanitizedHttpError(resp));
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      if (data && data.error) {
        const err = new Error(`Redis error: ${data.error}`);
        if (typeof data.error === 'string' && data.error.includes('NOPERM')) err.status = 403;
        throw err;
      }
      kvWriteDisabled = false;
      upstashReadOnlyDetected = false;
      return data;
    } else if (action === 'DEL') {
      resp = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['DEL', key]),
        signal: kvTimeoutSignal
      });
      if (!resp.ok) {
        const err = new Error(await readSanitizedHttpError(resp));
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      if (data && data.error) {
        const err = new Error(`Redis error: ${data.error}`);
        if (typeof data.error === 'string' && data.error.includes('NOPERM')) err.status = 403;
        throw err;
      }
      kvWriteDisabled = false;
      upstashReadOnlyDetected = false;
      return data;
    }
  } catch (err) {
    const isForbiddenWrite = isWriteAction && (
      err?.status === 403 ||
      (typeof err?.message === 'string' && (err.message.includes('403') || err.message.includes('NOPERM')))
    );
    if (isForbiddenWrite) {
      upstashReadOnlyDetected = true;
    }
    if (strict && isWriteAction) {
      if (!options?.silentLog) {
        console.error('Cloud KV strict write error:', action, key, err ? err.message : '');
      }
      throw createRedisWriteError(key, err);
    }
    if (isProduction && process.env.FAIL_CLOSED_STORAGE === 'true') {
      if (!options?.silentLog) {
        console.error('Cloud KV sync error:', action, key, err ? err.message : '');
      }
      throw err;
    }
    if (isForbiddenWrite) {
      if (!kvWriteDisabled) {
        kvWriteDisabled = true;
        console.log('[UPSTASH] Read-only Redis token detected (403 NOPERM); cloud write-back disabled until a Read-Write UPSTASH_REDIS_REST_TOKEN is configured.');
      }
      return null;
    }
    console.warn('Cloud KV sync warning:', action, key, err ? err.message : '');
    return null;
  }
  return null;
}

async function persistToCloudKvStrict(action, key, value = null, ttlSeconds = null) {
  if (!kvUrl || !kvToken) return null;
  return await syncWithCloudKv(action, key, value, ttlSeconds, { strict: true });
}

async function setCloudOtp(email, record) {
  otpStore.set(email, record);
  if (kvUrl && kvToken) {
    try {
      await syncWithCloudKv('SET', `otp:${email}`, record, 300);
    } catch (e) {}
  }
}

async function getCloudOtp(email) {
  if (kvUrl && kvToken) {
    try {
      const cloudRecord = await syncWithCloudKv('GET', `otp:${email}`);
      if (cloudRecord && cloudRecord.otp) {
        otpStore.set(email, cloudRecord);
        return cloudRecord;
      }
    } catch (e) {}
  }
  return otpStore.get(email) || null;
}

async function delCloudOtp(email) {
  otpStore.delete(email);
  if (kvUrl && kvToken) {
    try {
      await syncWithCloudKv('DEL', `otp:${email}`);
    } catch (e) {}
  }
}

async function setCloudSession(token, sessionData, ttlSeconds = 28800) {
  activeSessions.set(token, sessionData);
  if (kvUrl && kvToken) {
    try {
      await syncWithCloudKv('SET', `sess:${token}`, sessionData, ttlSeconds);
    } catch (e) {}
  }
}

async function delCloudSession(token) {
  if (!token) return;
  activeSessions.delete(token);
  if (kvUrl && kvToken) {
    try {
      await syncWithCloudKv('DEL', `sess:${token}`);
    } catch (e) {}
  }
}

async function getCloudSession(token) {
  if (!token) return null;
  let session = null;
  if (kvUrl && kvToken) {
    try {
      const cloudSess = await syncWithCloudKv('GET', `sess:${token}`);
      if (cloudSess && (cloudSess.email || cloudSess.empNo || cloudSess.role)) {
        session = cloudSess;
        activeSessions.set(token, cloudSess);
      }
    } catch (e) {}
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
  // Explicit headers always take precedence; cookie precedence follows route scope so an admin
  // testing the Employee Portal in another tab is not shadowed by emp_session on Management routes.
  const isEmpScopedRoute = typeof req.path === 'string' && (
    req.path.startsWith('/api/employee') ||
    req.path.startsWith('/api/exam') ||
    req.path.startsWith('/api/auth/employee')
  );
  const empCookie = req.signedCookies.emp_session || req.cookies.emp_session;
  const adminCookie = req.signedCookies.admin_session || req.cookies.admin_session;
  const evaluatorCookie = req.signedCookies.evaluator_session || req.cookies.evaluator_session;
  const sectionCookie = req.signedCookies.section_session || req.cookies.section_session;
  const deptCookie = req.signedCookies.dept_session || req.cookies.dept_session;

  const headerTokens = isEmpScopedRoute
    ? [
        req.headers['x-emp-token'],
        req.headers['x-admin-token'],
        req.headers['x-evaluator-token'],
        req.headers['x-section-token'],
        req.headers['x-dept-token'],
        req.headers['x-session-token'],
        req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null
      ]
    : [
        req.headers['x-admin-token'],
        req.headers['x-dept-token'],
        req.headers['x-section-token'],
        req.headers['x-evaluator-token'],
        req.headers['x-session-token'],
        req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null,
        req.headers['x-emp-token']
      ];

  const candidateTokens = [
    ...headerTokens,
    ...(isEmpScopedRoute
      ? [empCookie, adminCookie, evaluatorCookie, sectionCookie, deptCookie]
      : [adminCookie, deptCookie, sectionCookie, evaluatorCookie, empCookie])
  ].filter(Boolean);

  for (const token of candidateTokens) {
    const session = await getCloudSession(token);
    if (session) {
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
  }

  return null;
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

async function logAuditEvent(action, user, details, req = null, target = '') {
  const ip = req ? (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown') : 'system';
  const actorStr = typeof user === 'string'
    ? user
    : ((user && (user.email || user.username || user.name || user.empNo)) || 'Unknown');
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    action: String(action || 'EVENT'),
    user: String(actorStr),
    target: target ? String(target) : '',
    details: typeof details === 'string' ? details : JSON.stringify(details || ''),
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
  const actionFilter = String(req.query.action || '').trim().toUpperCase();
  const queryFilter = String(req.query.q || '').trim().toLowerCase();
  let logs = null;

  if (kvUrl && kvToken) {
    const cloudLogs = await syncWithCloudKv('GET', 'yokohama_audit_logs');
    if (cloudLogs && Array.isArray(cloudLogs)) logs = cloudLogs;
  }
  if (!logs) logs = auditLogsMemory;

  let filtered = Array.isArray(logs) ? logs : [];
  if (actionFilter && actionFilter !== 'ALL') {
    filtered = filtered.filter((l) => String(l.action || '').toUpperCase().includes(actionFilter));
  }
  if (queryFilter) {
    filtered = filtered.filter((l) =>
      `${l.action} ${l.user} ${l.target || ''} ${l.details} ${l.ip}`.toLowerCase().includes(queryFilter)
    );
  }
  return res.json({ success: true, logs: filtered });
});

app.post('/api/audit-export', requireAnyAuth, async (req, res) => {
  const { exportType, summary, target } = req.body || {};
  await logAuditEvent(
    String(exportType || 'EXPORT_DATA').toUpperCase().slice(0, 48),
    req.authUser,
    String(summary || 'User exported portal data').slice(0, 300),
    req,
    String(target || '')
  );
  return res.json({ success: true });
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

  if (process.env.NODE_ENV === 'test') {
    await logAuditEvent('SEND_ADMIN_OTP', emailRaw, 'OTP dispatched (test environment)', req);
    return res.json({
      success: true,
      message: '✉️ OTP sent to your email inbox. Valid for 5 minutes. Please check your Gmail and enter the 6-digit OTP.',
      expiresIn: OTP_DURATION_SECONDS
    });
  }

  try {
    await transporter.sendMail(mailOptions);
    await logAuditEvent('SEND_ADMIN_OTP', emailRaw, 'OTP dispatched to email', req);
    return res.json({
      success: true,
      message: '✉️ OTP sent to your email inbox. Valid for 5 minutes. Please check your Gmail and enter the 6-digit OTP.',
      expiresIn: OTP_DURATION_SECONDS
    });
  } catch (error) {
    console.error('Email send failed:', error ? error.message : '');
    return res.status(500).json({
      success: false,
      message: 'Failed to dispatch email OTP. Please check server SMTP configuration.'
    });
  }
});

// ---------------------------------------------------------------------
// API ROUTE: POST /api/auth/admin/login (DB Hashed Accounts + Env Credentials)
// ---------------------------------------------------------------------
app.post('/api/auth/admin/login', authRateLimiter(), async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username/email and password required'
    });
  }

  let matchedUser = null;
  let blockAdminLegacyFallback = false;

  // 1. Check Redis/memory individual hashed staff user account first
  try {
    const staffList = await getAuthoritativeStaffUsers();
    const dbUser = await findStaffUserByIdentifier(username);
    if (dbUser) {
      if (!dbUser.isActive || dbUser.passwordCustom) {
        blockAdminLegacyFallback = true;
      }
      if (dbUser.isActive && ['SUPERADMIN', 'ADMIN'].includes(dbUser.role) && dbUser.passwordHash) {
        const ok = await verifyStaffPassword(password, dbUser.passwordHash);
        if (ok) {
          matchedUser = {
            uid: dbUser.uid,
            username: dbUser.username,
            email: dbUser.email,
            name: dbUser.displayName || 'Administrator',
            role: dbUser.role
          };
        }
      }
    } else {
      // If seeded primary superadmin changed its username or password, block legacy fallback
      const primarySuper = staffList.find((u) => Number(u.id) === 1 && u.role === 'SUPERADMIN');
      if (primarySuper && (primarySuper.passwordCustom || !primarySuper.isActive)) {
        blockAdminLegacyFallback = true;
      }
    }
  } catch (e) {
    console.warn('[STAFF AUTH WARN] admin login check:', e.message);
  }

  // 2. Fallback to env configured master administrator (required for automated tests / headless bootstrapping)
  if (!matchedUser && !blockAdminLegacyFallback && (process.env.NODE_ENV === 'test' || process.env.ALLOW_LEGACY_ROLE_LOGIN !== 'false')) {
    const envUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    const envPass = (process.env.ADMIN_PASSWORD || 'admin123').trim();
    const envEmail = (process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com').trim().toLowerCase();

    const uLower = username.toLowerCase();
    const validUsers = [envUser.toLowerCase(), envEmail, 'admin'].filter(Boolean);
    const isUserValid = validUsers.includes(uLower);

    let isPassValid = false;
    try {
      const pBuf = Buffer.from(password);
      const epBuf = Buffer.from(envPass);
      isPassValid = pBuf.length === epBuf.length && crypto.timingSafeEqual(pBuf, epBuf);
    } catch (e) {
      isPassValid = false;
    }

    if (isUserValid && isPassValid) {
      matchedUser = {
        email: envEmail,
        name: 'Administrator',
        role: 'SUPERADMIN'
      };
    }
  }

  if (matchedUser) {
    if (req.recordAuthSuccess) await req.recordAuthSuccess();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionData = {
      email: matchedUser.email,
      username: matchedUser.username || username,
      name: matchedUser.name,
      role: matchedUser.role,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + (8 * 60 * 60 * 1000)
    };

    await setCloudSession(sessionToken, sessionData, 28800);
    res.cookie('admin_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
    await logAuditEvent('ADMIN_LOGIN_PASSWORD', sessionData.email || sessionData.username, 'Admin signed in via password', req, sessionData.role);

    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      token: sessionToken,
      admin: {
        email: sessionData.email,
        name: sessionData.name,
        role: sessionData.role
      }
    });
  }

  return handleAuthFailure(req, res, 401, 'Invalid credentials');
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
    res.cookie('admin_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
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
// EVALUATOR AUTHENTICATION (Individual PG Accounts + Role Fallback)
// ---------------------------------------------------------------------
const EVALUATOR_CREDENTIALS = {
  'safety': process.env.EVALUATOR_PASS_SAFETY || 'safety123',
  'ci & tpm': process.env.EVALUATOR_PASS_CI || 'ci123',
  'quality': process.env.EVALUATOR_PASS_QUALITY || 'quality123',
  'technical': process.env.EVALUATOR_PASS_TECH || 'tech123',
  'hr': process.env.EVALUATOR_PASS_HR || 'hr123'
};

async function resolveScopedStaffAuth({ username, defaultIdentifier, role, department, section, password, allowedRoles, legacyExpectedPass }) {
  let matchedAccount = null;
  let blockFallback = false;
  try {
    const usersList = await getAuthoritativeStaffUsers();
    const candidates = username
      ? findScopedStaffMatches(usersList, { identifier: username })
      : [
          ...(defaultIdentifier ? findScopedStaffMatches(usersList, { identifier: defaultIdentifier }) : []),
          ...findScopedStaffMatches(usersList, { role, department, section })
        ];
    const unique = Array.from(new Map(candidates.map((u) => [u.id, u])).values());
    for (const dbUser of unique) {
      if (!dbUser.isActive || dbUser.passwordCustom) blockFallback = true;
      if (dbUser.isActive && allowedRoles.includes(dbUser.role) && dbUser.passwordHash) {
        if (await verifyStaffPassword(password, dbUser.passwordHash)) {
          matchedAccount = dbUser;
          break;
        }
      }
    }
    if (username && unique.length > 0 && !matchedAccount) {
      blockFallback = true;
    }
  } catch (e) {}

  let isValid = Boolean(matchedAccount);
  if (!isValid && !blockFallback && (process.env.NODE_ENV === 'test' || process.env.ALLOW_LEGACY_ROLE_LOGIN !== 'false')) {
    try {
      const pBuf = Buffer.from(password);
      const expBuf = Buffer.from(legacyExpectedPass);
      if (pBuf.length === expBuf.length && crypto.timingSafeEqual(pBuf, expBuf)) {
        isValid = true;
      }
    } catch (e) {}
  }
  return { isValid, matchedAccount };
}

app.post('/api/auth/evaluator/login', authRateLimiter(), async (req, res) => {
  const section = (req.body.section || 'Safety').trim();
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!password) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  const secKey = section.toLowerCase();
  const defaultUsername = secKey.includes('safety') ? 'eval.safety'
    : secKey.includes('ci') ? 'eval.ci'
    : secKey.includes('quality') ? 'eval.quality'
    : secKey.includes('tech') ? 'eval.tech'
    : secKey === 'hr' ? 'eval.hr'
    : '';
  const { isValid, matchedAccount } = await resolveScopedStaffAuth({
    username,
    defaultIdentifier: defaultUsername,
    role: 'EVALUATOR',
    section,
    password,
    allowedRoles: ['EVALUATOR', 'ADMIN', 'SUPERADMIN'],
    legacyExpectedPass: EVALUATOR_CREDENTIALS[secKey] || process.env.EVALUATOR_PASSWORD || 'ojt123'
  });

  if (!isValid) {
    return handleAuthFailure(req, res, 401, 'Invalid credentials');
  }

  if (req.recordAuthSuccess) await req.recordAuthSuccess();

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const assignedSection = (matchedAccount && matchedAccount.section) ? matchedAccount.section : section;
  const sessionData = {
    role: 'EVALUATOR',
    section: assignedSection,
    username: matchedAccount ? matchedAccount.username : undefined,
    email: matchedAccount ? matchedAccount.email : undefined,
    name: (matchedAccount && matchedAccount.displayName) || `${assignedSection} Evaluator`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('evaluator_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
  await logAuditEvent('EVALUATOR_LOGIN', sessionData.email || sessionData.name, `Logged in to ${assignedSection} practical evaluation`, req, assignedSection);

  return res.json({
    success: true,
    message: `Signed in as ${assignedSection} Evaluator`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// SECTION HEAD AUTHENTICATION (Individual PG Accounts + Role Fallback)
// ---------------------------------------------------------------------
app.post('/api/auth/section/login', authRateLimiter(), async (req, res) => {
  const rawSection = (req.body.section || '').trim();
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!rawSection || !password) {
    return res.status(400).json({ success: false, message: 'Section name and credentials required' });
  }

  const { isValid, matchedAccount } = await resolveScopedStaffAuth({
    username,
    defaultIdentifier: undefined,
    role: 'SECTION_HEAD',
    section: rawSection,
    password,
    allowedRoles: ['SECTION_HEAD', 'ADMIN', 'SUPERADMIN'],
    legacyExpectedPass: process.env.SECTION_PASSWORD || 'section123'
  });

  if (!isValid) {
    return handleAuthFailure(req, res, 401, 'Invalid credentials');
  }

  if (req.recordAuthSuccess) await req.recordAuthSuccess();

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const assignedSection = (matchedAccount && matchedAccount.section && matchedAccount.section.toLowerCase() !== rawSection.toLowerCase())
    ? matchedAccount.section
    : rawSection;
  const sessionData = {
    role: 'SECTION_HEAD',
    section: assignedSection,
    username: matchedAccount ? matchedAccount.username : undefined,
    email: matchedAccount ? matchedAccount.email : undefined,
    name: (matchedAccount && matchedAccount.displayName) || `${assignedSection} Section Head`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('section_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
  await logAuditEvent('SECTION_LOGIN', sessionData.email || sessionData.name, `Logged in to ${assignedSection} portal`, req, assignedSection);

  return res.json({
    success: true,
    message: `Signed in as ${assignedSection} Section Head`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// DEPARTMENT / HOD AUTHENTICATION (Individual PG Accounts + Role Fallback)
// ---------------------------------------------------------------------
app.post('/api/auth/dept/login', authRateLimiter(), async (req, res) => {
  const department = normalizeDepartmentName(req.body.department || 'QUALITY CONTROL');
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!password) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  const defaultUser = department === 'QUALITY CONTROL' ? 'hod.qc'
    : department === 'PRODUCTION' ? 'hod.production' : '';
  const { isValid, matchedAccount } = await resolveScopedStaffAuth({
    username,
    defaultIdentifier: defaultUser,
    role: 'DEPT_HEAD',
    department,
    password,
    allowedRoles: ['DEPT_HEAD', 'ADMIN', 'SUPERADMIN'],
    legacyExpectedPass: process.env.DEPT_PASSWORD || 'hod123'
  });

  if (!isValid) {
    return handleAuthFailure(req, res, 401, 'Invalid credentials');
  }

  if (req.recordAuthSuccess) await req.recordAuthSuccess();

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const assignedDept = (matchedAccount && matchedAccount.department && matchedAccount.department !== 'ALL')
    ? matchedAccount.department
    : department;
  const sessionData = {
    role: 'DEPT_HEAD',
    department: assignedDept,
    username: matchedAccount ? matchedAccount.username : undefined,
    email: matchedAccount ? matchedAccount.email : undefined,
    name: (matchedAccount && matchedAccount.displayName) || `${assignedDept} HOD`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(sessionToken, sessionData, 28800);
  res.cookie('dept_session', sessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
  await logAuditEvent('DEPT_LOGIN', sessionData.email || sessionData.name, `Logged in to Department dashboard`, req, assignedDept);

  return res.json({
    success: true,
    message: `Signed in as ${assignedDept} HOD`,
    token: sessionToken,
    user: sessionData
  });
});

// ---------------------------------------------------------------------
// STAFF USER MANAGEMENT (Redis-Backed)
// ---------------------------------------------------------------------

async function handleSaveStaffUserRequest(req, res, explicitId) {
  const { id, username, email, displayName, role, department, section, password, isActive } = req.body || {};
  const targetId = explicitId !== undefined && explicitId !== null ? explicitId : id;
  const isEditing = targetId !== undefined && targetId !== null && String(targetId).trim() !== '';

  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanDisplayName = String(displayName || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanUsername || !/^[a-z0-9._@-]{2,64}$/i.test(cleanUsername)) {
    return res.status(400).json({
      success: false,
      message: 'Valid username is required (2-64 chars: letters, numbers, ., _, -, @)'
    });
  }
  if (!cleanDisplayName || cleanDisplayName.length > 100) {
    return res.status(400).json({ success: false, message: 'Display name is required (1-100 chars)' });
  }
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ success: false, message: 'Valid email address is required' });
  }
  const allowedRoles = ['SUPERADMIN', 'ADMIN', 'DEPT_HEAD', 'SECTION_HEAD', 'EVALUATOR', 'emp'];
  if (!role || !allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role' });
  }
  const trimmedPassword = password !== undefined && password !== null ? String(password).trim() : '';
  if (!isEditing && trimmedPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Password (minimum 6 characters) is required for a new staff account' });
  }
  if (trimmedPassword && (trimmedPassword.length < 6 || trimmedPassword.length > 128)) {
    return res.status(400).json({ success: false, message: 'Password must be between 6 and 128 characters' });
  }

  const result = await upsertStaffAccountAuthoritative({
    id: isEditing ? targetId : undefined,
    requirePassword: !isEditing,
    username: cleanUsername,
    email: cleanEmail || `${cleanUsername}@atctires.local`,
    displayName: cleanDisplayName,
    role,
    department: department !== undefined && department !== null && String(department).trim() !== ''
      ? (String(department).trim().toUpperCase() === 'ALL' ? 'ALL' : normalizeDepartmentName(department))
      : null,
    section: section !== undefined && section !== null && String(section).trim() !== '' ? String(section).trim() : null,
    password: trimmedPassword || undefined,
    isActive: isActive !== undefined ? Boolean(isActive) : true
  });

  if (result.errorStatus) {
    return res.status(result.errorStatus).json({ success: false, message: result.errorMessage });
  }

  const saved = result.user;
  await logAuditEvent(
    result.isNew ? 'CREATE_STAFF_USER' : 'UPDATE_STAFF_USER',
    req.authUser,
    `${result.isNew ? 'Created' : 'Updated'} staff account @${saved.username} (${saved.role}, ${saved.isActive ? 'Active' : 'Disabled'})`,
    req,
    saved.username
  );
  return res.json({
    success: true,
    mode: result.isNew ? 'created' : 'updated',
    user: sanitizeStaffUserRecord(saved)
  });
}

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
  const list = await listStaffUsersAuthoritative();
  return res.json({ success: true, users: list, source: kvUrl && kvToken ? 'redis' : 'memory' });
});

app.post('/api/admin/users', requireSuperAdminAuth, (req, res) => handleSaveStaffUserRequest(req, res, undefined));

app.put('/api/admin/users/:id', requireSuperAdminAuth, (req, res) => handleSaveStaffUserRequest(req, res, req.params.id));

app.patch('/api/admin/users/:id', requireSuperAdminAuth, (req, res) => handleSaveStaffUserRequest(req, res, req.params.id));

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

// Employee Password Cryptographic Engine (Salted scrypt + Legacy SHA256 migration)
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;
  try {
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
      return bcrypt.compareSync(password, storedHash);
    }
    if (storedHash.startsWith('scrypt:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 3) return false;
      const salt = parts[1];
      const expectedHash = parts[2];
      const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
    }
    const sha = crypto.createHash('sha256').update(password).digest('hex');
    return sha === storedHash;
  } catch (err) {
    return false;
  }
}

function normalizeDoj(dojStr) {
  if (!dojStr) return '';
  const s = String(dojStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    return `${year}-${month}-${day}`;
  }
  return s;
}

const entityLocks = new Map();

async function acquireEntityLock(key) {
  while (entityLocks.has(key)) {
    await entityLocks.get(key);
  }
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  entityLocks.set(key, promise);
  return () => {
    entityLocks.delete(key);
    release();
  };
}

app.post('/api/auth/employee/login', authRateLimiter(), async (req, res) => {
  const empNoRaw = String(req.body.empNo || req.body.username || '').trim();
  const password = String(req.body.password || '').trim();

  if (!empNoRaw || !password) {
    return res.status(400).json({ success: false, message: 'Employee Number and password are required' });
  }

  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e =>
    String(e.empNo).trim().toLowerCase() === empNoRaw.toLowerCase() ||
    String(e.empNo).trim().toLowerCase() === ('0' + empNoRaw).toLowerCase()
  );

  if (!emp) {
    return handleAuthFailure(req, res, 401, 'Invalid credentials');
  }

  if (emp.isLeft || emp.status === 'LEFT') {
    return res.status(403).json({ success: false, message: 'Employee account is inactive (marked Left). Contact HR administrator.' });
  }

  const canonicalEmpNo = String(emp.empNo).trim().toLowerCase();
  const matchesDefaultEmpNo =
    password.toLowerCase() === canonicalEmpNo ||
    ('0' + password).toLowerCase() === canonicalEmpNo;

  let isValid = false;
  if (emp.hasCustomPassword && emp.passwordHash) {
    isValid = verifyPassword(password, emp.passwordHash);
  } else {
    isValid = matchesDefaultEmpNo;
  }

  if (!isValid) {
    return handleAuthFailure(req, res, 401, 'Invalid credentials');
  }

  if (req.recordAuthSuccess) await req.recordAuthSuccess();

  // Upgrade legacy non-bcrypt hash seamlessly if an explicit custom password hash matched
  if (emp.hasCustomPassword && emp.passwordHash && !emp.passwordHash.startsWith('$2') && verifyPassword(password, emp.passwordHash)) {
    emp.passwordHash = hashPassword(password);
    saveAuthoritativeEmployees(employees).catch(() => {});
  }

  const empSessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    role: 'emp',
    empNo: emp.empNo,
    name: emp.name,
    section: emp.section,
    dept: emp.dept,
    currentLevel: emp.currentLevel,
    targetLevel: emp.targetLevel || calculateDojEligibility(emp.doj, emp.currentLevel).eligibleLevel,
    doj: emp.doj,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (8 * 60 * 60 * 1000)
  };

  await setCloudSession(empSessionToken, sessionData, 28800);
  res.cookie('emp_session', empSessionToken, getCookieOptions(8 * 60 * 60 * 1000, req));
  await logAuditEvent('EMPLOYEE_LOGIN', emp.empNo, 'Employee signed in to portal', req, emp.empNo);

  return res.json({
    success: true,
    message: 'Employee authenticated successfully',
    token: empSessionToken,
    employee: sessionData
  });
});

app.post('/api/admin/employees/:empNo/reset-password', requireAdminAuth, async (req, res) => {
  const empNoRaw = (req.params.empNo || '').trim();
  const newPassword = (req.body.newPassword || '').trim();

  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === empNoRaw.toLowerCase());
  if (!emp) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }

  if (newPassword) {
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    emp.passwordHash = hashPassword(newPassword);
    emp.hasCustomPassword = true;
  } else {
    delete emp.passwordHash;
    delete emp.hasCustomPassword;
  }
  delete emp.password;

  await saveAuthoritativeEmployees(employees);
  await logAuditEvent('ADMIN_RESET_EMP_PASSWORD', req.authUser.email || req.authUser.name, `Admin reset password for employee ${emp.empNo}`, req);

  return res.json({
    success: true,
    message: newPassword
      ? `Password updated for employee ${emp.empNo}`
      : `Password reset to default Employee Number (${emp.empNo}).`
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
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === String(user.empNo).trim().toLowerCase());
  if (emp) {
    user.currentLevel = emp.currentLevel;
    user.targetLevel = emp.targetLevel || calculateDojEligibility(emp.doj, emp.currentLevel).eligibleLevel;
    user.skillLevelAssess2025 = emp.skillLevelAssess2025;
    user.skillLevelExpBased = emp.skillLevelExpBased;
  }
  return res.json({ success: true, authenticated: true, employee: user });
});

// ---------------------------------------------------------------------
// AUTHORITATIVE DATA PERSISTENCE ENGINE (Upstash Cloud & Resilient Disk Backup)
// ---------------------------------------------------------------------
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
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([k, v]) => {
        if (k !== '__initialized') globalAssessmentRecords.set(String(k), v);
      });
      globalAssessmentRecords._isExplicitlyCleared = true;
    }
  } else {
    const seedPath = path.join(__dirname, 'seed_data.js');
    if (fs.existsSync(seedPath)) {
      require(seedPath);
      if (global.SEED_RECORDS && typeof global.SEED_RECORDS === 'object') {
        Object.entries(global.SEED_RECORDS).forEach(([k, v]) => {
          if (k !== '__initialized') globalAssessmentRecords.set(String(k), v);
        });
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
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([k, v]) => {
        if (k !== '__initialized') globalOjtEvaluations.set(String(k), v);
      });
      globalOjtEvaluations._isExplicitlyCleared = true;
    }
  } else {
    const seedOjtPath = path.join(__dirname, 'seed_ojt.js');
    if (fs.existsSync(seedOjtPath)) {
      const seedOjt = require(seedOjtPath);
      if (seedOjt && typeof seedOjt === 'object') {
        Object.entries(seedOjt).forEach(([k, v]) => {
          if (k !== '__initialized') globalOjtEvaluations.set(String(k), v);
        });
      }
    }
  }
} catch (e) {}

// Validation helpers for base dataset schema
function validateEmployeesList(list) {
  if (!Array.isArray(list) || list.length < 1) return null;
  const valid = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (!item.empNo || typeof item.empNo !== 'string') continue;
    if (!item.name || typeof item.name !== 'string') continue;
    valid.push(item);
  }
  return valid.length >= 1 ? valid : null;
}

function validateQuestionBankObj(bank) {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) return null;
  const levels = ['L', 'U', 'O'];
  for (const lvl of levels) {
    if (!Array.isArray(bank[lvl]) || bank[lvl].length === 0) return null;
    for (const q of bank[lvl]) {
      if (!q || typeof q !== 'object' || !q.id || !q.question || !Array.isArray(q.options)) {
        return null;
      }
    }
  }
  return bank;
}

// Fallback Loader from data.js if files/redis are uninitialized
function loadBaseDatasetFromDataJs() {
  try {
    const dataJsPath = path.join(__dirname, 'data.js');
    if (!fs.existsSync(dataJsPath)) return null;
    const content = fs.readFileSync(dataJsPath, 'utf-8');

    // Extract EMPLOYEES array safely using strict boundary matching
    let emps = null;
    const empStart = content.indexOf('const EMPLOYEES = [');
    if (empStart !== -1) {
      const empBracket = content.indexOf('[', empStart);
      const empEnd = content.indexOf('];', empBracket);
      if (empEnd !== -1) {
        const empsStr = content.slice(empBracket, empEnd + 1);
        try {
          const parsed = JSON.parse(empsStr);
          emps = validateEmployeesList(parsed);
        } catch (e) {
          console.error('Failed to parse EMPLOYEES from data.js:', e.message);
        }
      }
    }

    // Extract QUESTION_BANK safely using strict boundary matching
    let qb = null;
    const qbStart = content.indexOf('const QUESTION_BANK = {');
    const qbEnd = content.indexOf('const LEVEL_RULES = {');
    if (qbStart !== -1 && qbEnd !== -1) {
      const qbStr = content.slice(qbStart + 'const QUESTION_BANK = '.length, qbEnd).trim().replace(/;$/, '');
      try {
        const parsed = JSON.parse(qbStr);
        qb = validateQuestionBankObj(parsed);
      } catch (e) {
        console.error('Failed to parse QUESTION_BANK from data.js:', e.message);
      }
    }

    if (!emps || !qb) {
      console.warn('Fallback base dataset loading from data.js was incomplete or invalid');
      return null;
    }

    return { employees: emps, questionBank: qb };
  } catch (err) {
    console.error('Error loading fallback base dataset from data.js:', err ? err.message : '');
    return null;
  }
}

// Redis Persistence Stores + In-Memory Fallbacks (Sole Database Engine)
const softBackupsMemory = new Map();
const schedulesMemory = new Map();
let staffUsersMemory = null;

async function verifyStaffPassword(plainPassword, hash) {
  if (!plainPassword || !hash) return false;
  try {
    return await bcrypt.compare(plainPassword, hash);
  } catch {
    return false;
  }
}

async function getAuthoritativeStaffUsers() {
  if (kvUrl && kvToken) {
    try {
      const cloudUsers = await syncWithCloudKv('GET', 'yokohama_staff_users');
      if (Array.isArray(cloudUsers) && cloudUsers.length > 0) {
        staffUsersMemory = cloudUsers;
        return cloudUsers;
      }
    } catch (e) {}
  }
  if (Array.isArray(staffUsersMemory) && staffUsersMemory.length > 0) {
    return staffUsersMemory;
  }

  // Seed default staff accounts on first boot (strictly respects env passwords)
  const adminEmail = (process.env.ADMIN_EMAIL || 'reubengeoffrey16@gmail.com').trim().toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const deptPass = process.env.DEPT_PASSWORD || 'hod123';
  const secPass = process.env.SECTION_PASSWORD || 'section123';
  const defaultsSpec = [
    { username: process.env.ADMIN_USERNAME || 'admin', email: adminEmail, displayName: 'HR Control Administrator', role: 'SUPERADMIN', password: adminPass, department: 'ALL' },
    { username: 'hod.qc', email: 'hod.qc@atctires.local', displayName: 'Quality Control HOD', role: 'DEPT_HEAD', password: deptPass, department: 'QUALITY CONTROL' },
    { username: 'hod.production', email: 'hod.production@atctires.local', displayName: 'Production HOD', role: 'DEPT_HEAD', password: deptPass, department: 'PRODUCTION' },
    { username: 'sec.tb', email: 'sec.tb@atctires.local', displayName: 'Tire Building QA Supervisor', role: 'SECTION_HEAD', password: secPass, section: 'Tire Building QA', department: 'QUALITY CONTROL' },
    { username: 'eval.safety', email: 'eval.safety@atctires.local', displayName: 'Safety Practical Evaluator', role: 'EVALUATOR', password: process.env.EVALUATOR_PASS_SAFETY || 'safety123', section: 'Safety', department: 'SAFETY' },
    { username: 'eval.ci', email: 'eval.ci@atctires.local', displayName: 'CI & TPM Evaluator', role: 'EVALUATOR', password: process.env.EVALUATOR_PASS_CI || 'ci123', section: 'CI & TPM', department: 'CI & TPM' },
    { username: 'eval.quality', email: 'eval.quality@atctires.local', displayName: 'Quality Evaluator', role: 'EVALUATOR', password: process.env.EVALUATOR_PASS_QUALITY || 'quality123', section: 'Quality', department: 'QUALITY CONTROL' },
    { username: 'eval.tech', email: 'eval.tech@atctires.local', displayName: 'Technical Evaluator', role: 'EVALUATOR', password: process.env.EVALUATOR_PASS_TECH || 'tech123', section: 'Technical', department: 'TECHNICAL' },
    { username: 'eval.hr', email: 'eval.hr@atctires.local', displayName: 'HR Competency Evaluator', role: 'EVALUATOR', password: process.env.EVALUATOR_PASS_HR || 'hr123', section: 'HR', department: 'HR' },
  ];

  const seeded = [];
  for (let i = 0; i < defaultsSpec.length; i++) {
    const d = defaultsSpec[i];
    const cleanUsername = String(d.username).trim().toLowerCase();
    const now = new Date().toISOString();
    seeded.push({
      id: i + 1,
      uid: `staff:${cleanUsername}`,
      username: cleanUsername,
      email: String(d.email).trim().toLowerCase(),
      displayName: d.displayName,
      role: d.role,
      empNo: null,
      section: d.section || null,
      department: d.department || null,
      passwordHash: await bcrypt.hash(d.password, 10),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  staffUsersMemory = seeded;
  if (kvUrl && kvToken) {
    try { await syncWithCloudKv('SET', 'yokohama_staff_users', seeded); } catch (e) {}
  }
  return seeded;
}

async function saveAuthoritativeStaffUsers(usersList) {
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', 'yokohama_staff_users', usersList);
  }
  staffUsersMemory = usersList;
}

async function findStaffUserByIdentifier(identifier) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return null;
  const usersList = await getAuthoritativeStaffUsers();
  return usersList.find((u) =>
    String(u.username || '').toLowerCase() === clean ||
    String(u.email || '').toLowerCase() === clean ||
    String(u.empNo || '').toLowerCase() === clean
  ) || null;
}

async function listStaffUsersAuthoritative() {
  const usersList = await getAuthoritativeStaffUsers();
  return usersList.map((u) => ({
    id: u.id,
    uid: u.uid,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    empNo: u.empNo,
    section: u.section,
    department: u.department,
    isActive: u.isActive,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));
}

function sanitizeStaffUserRecord(u) {
  return {
    id: u.id,
    uid: u.uid,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    empNo: u.empNo,
    section: u.section,
    department: u.department,
    isActive: u.isActive,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function findScopedStaffMatches(usersList, { identifier, role, department, section }) {
  const cleanId = String(identifier || '').trim().toLowerCase();
  if (cleanId) {
    return usersList.filter((u) =>
      String(u.username || '').toLowerCase() === cleanId ||
      String(u.email || '').toLowerCase() === cleanId ||
      String(u.empNo || '').toLowerCase() === cleanId
    );
  }
  if (role === 'DEPT_HEAD' && department) {
    const targetDept = normalizeDepartmentName(department);
    return usersList.filter((u) => u.role === 'DEPT_HEAD' && normalizeDepartmentName(u.department) === targetDept);
  }
  if (role === 'SECTION_HEAD' && section) {
    const targetSec = String(section).trim().toLowerCase();
    return usersList.filter((u) => u.role === 'SECTION_HEAD' && String(u.section || '').trim().toLowerCase() === targetSec);
  }
  if (role === 'EVALUATOR' && section) {
    const targetSec = String(section).trim().toLowerCase();
    return usersList.filter((u) => u.role === 'EVALUATOR' && String(u.section || '').trim().toLowerCase() === targetSec);
  }
  return [];
}

async function upsertStaffAccountAuthoritative(input) {
  const usersList = [...(await getAuthoritativeStaffUsers())];
  const hasExplicitId = input.id !== undefined && input.id !== null && String(input.id).trim() !== '';
  const cleanUsername = String(input.username || input.email || '').trim().toLowerCase();
  const cleanEmail = String(input.email || '').trim().toLowerCase();
  const cleanDisplayName = String(input.displayName || '').trim();
  const passwordHash = input.password ? await bcrypt.hash(String(input.password), 10) : undefined;
  const now = new Date().toISOString();

  if (hasExplicitId) {
    const idx = usersList.findIndex((u) => String(u.id) === String(input.id).trim());
    if (idx < 0) {
      return { errorStatus: 404, errorMessage: 'Staff account not found' };
    }
    const existing = usersList[idx];
    const nextUsername = cleanUsername || String(existing.username || '').toLowerCase();
    const nextEmail = cleanEmail || String(existing.email || '').toLowerCase();
    const nextRole = input.role || existing.role;
    const nextIsActive = input.isActive !== undefined ? Boolean(input.isActive) : (existing.isActive !== false);

    const conflictUser = usersList.find((u, i) => i !== idx && (
      String(u.username || '').toLowerCase() === nextUsername ||
      (nextEmail && String(u.email || '').toLowerCase() === nextEmail)
    ));
    if (conflictUser) {
      return { errorStatus: 409, errorMessage: 'Username or email is already assigned to another staff account' };
    }

    if (existing.role === 'SUPERADMIN' && (nextRole !== 'SUPERADMIN' || !nextIsActive)) {
      const otherActiveSuper = usersList.some((u, i) => i !== idx && u.role === 'SUPERADMIN' && u.isActive !== false);
      if (!otherActiveSuper) {
        return { errorStatus: 400, errorMessage: 'Cannot disable or demote the last active SUPERADMIN account' };
      }
    }

    const updated = {
      ...existing,
      uid: existing.uid && String(existing.uid).startsWith('staff:') ? `staff:${nextUsername}` : existing.uid,
      username: nextUsername,
      email: nextEmail,
      displayName: cleanDisplayName || existing.displayName,
      role: nextRole,
      department: input.department !== undefined ? input.department : existing.department,
      section: input.section !== undefined ? input.section : existing.section,
      empNo: input.empNo !== undefined ? input.empNo : existing.empNo,
      isActive: nextIsActive,
      ...(passwordHash ? { passwordHash, passwordCustom: true } : {}),
      updatedAt: now,
    };
    usersList[idx] = updated;
    await saveAuthoritativeStaffUsers(usersList);
    return { user: updated, isNew: false };
  }

  const duplicate = usersList.find((u) =>
    String(u.username || '').toLowerCase() === cleanUsername ||
    (cleanEmail && String(u.email || '').toLowerCase() === cleanEmail)
  );
  if (duplicate) {
    return { errorStatus: 409, errorMessage: 'Username or email already exists. Click Edit on the user row to modify it.' };
  }

  if (!passwordHash && input.requirePassword) {
    return { errorStatus: 400, errorMessage: 'Password (minimum 6 characters) is required for a new staff account' };
  }

  const nextId = usersList.reduce((m, u) => Math.max(m, Number(u.id || 0)), 0) + 1;
  const created = {
    id: nextId,
    uid: `staff:${cleanUsername}`,
    username: cleanUsername,
    email: cleanEmail || `${cleanUsername}@atctires.local`,
    displayName: cleanDisplayName || cleanUsername,
    role: input.role,
    empNo: input.empNo || null,
    section: input.section || null,
    department: input.department || null,
    passwordHash: passwordHash || null,
    passwordCustom: Boolean(passwordHash),
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : true,
    createdAt: now,
    updatedAt: now,
  };
  usersList.push(created);
  await saveAuthoritativeStaffUsers(usersList);
  return { user: created, isNew: true };
}

async function getOrCreateStaffUserAuthoritative(uid, email, displayName) {
  const usersList = [...(await getAuthoritativeStaffUsers())];
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(displayName || cleanEmail.split('@')[0] || 'User').trim();
  const now = new Date().toISOString();
  const idx = usersList.findIndex((u) =>
    String(u.uid || '') === uid || String(u.email || '').toLowerCase() === cleanEmail
  );
  if (idx >= 0) {
    usersList[idx] = {
      ...usersList[idx],
      uid,
      email: cleanEmail,
      displayName: cleanName || usersList[idx].displayName,
      updatedAt: now,
    };
    await saveAuthoritativeStaffUsers(usersList);
    return usersList[idx];
  }
  const nextId = usersList.reduce((m, u) => Math.max(m, Number(u.id || 0)), 0) + 1;
  const created = {
    id: nextId,
    uid,
    username: cleanEmail,
    email: cleanEmail,
    displayName: cleanName,
    role: 'emp',
    empNo: null,
    section: null,
    department: null,
    passwordHash: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  usersList.push(created);
  await saveAuthoritativeStaffUsers(usersList);
  return created;
}

const kvCacheTs = { settings: 0, questions: 0, records: 0, employees: 0, ojt: 0 };

function readLocalSeedEmployees() {
  if (fs.existsSync(EMPLOYEES_JSON_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(EMPLOYEES_JSON_FILE, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {}
  }
  const base = loadBaseDatasetFromDataJs();
  return (base && Array.isArray(base.employees) && base.employees.length > 0) ? base.employees : [];
}

function readLocalSeedRecords() {
  if (fs.existsSync(RECORDS_JSON_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(RECORDS_JSON_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}
  }
  try {
    const seedPath = path.join(__dirname, 'seed_data.js');
    if (fs.existsSync(seedPath)) {
      require(seedPath);
      if (global.SEED_RECORDS && typeof global.SEED_RECORDS === 'object') return global.SEED_RECORDS;
    }
  } catch (e) {}
  return {};
}

function readLocalSeedOjt() {
  if (fs.existsSync(OJT_JSON_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(OJT_JSON_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}
  }
  try {
    const seedOjtPath = path.join(__dirname, 'seed_ojt.js');
    if (fs.existsSync(seedOjtPath)) {
      const seedOjt = require(seedOjtPath);
      if (seedOjt && typeof seedOjt === 'object') return seedOjt;
    }
  } catch (e) {}
  return {};
}

function readLocalSeedQuestions() {
  if (fs.existsSync(QUESTIONS_JSON_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(QUESTIONS_JSON_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed;
    } catch (e) {}
  }
  const base = loadBaseDatasetFromDataJs();
  if (base && base.questionBank && Object.keys(base.questionBank).length > 0) return base.questionBank;
  return { L: [], U: [], O: [] };
}

function readLocalSeedSettings() {
  if (fs.existsSync(SETTINGS_JSON_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_JSON_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (e) {}
  }
  return { ...DEFAULT_SETTINGS };
}

// Automatic one-time migration from bundled local JSON to Upstash Redis on first startup
// Includes per-step transient retry and never overwrites existing non-empty keys (or cleared __initialized maps).
async function ensureUpstashInitialSeed() {
  if (!kvUrl || !kvToken || upstashSeedCompleted || upstashReadOnlyDetected) return { skipped: true };
  if (upstashSeedPromise) return await upstashSeedPromise;
  upstashLastSeedAttemptAt = Date.now();
  upstashSeedAttempts += 1;

  upstashSeedPromise = (async () => {
    const seededKeys = [];
    try {
      const pingRes = await withUpstashStepRetry('PING', () => callCloudKvCommand(['PING']));
      if (pingRes !== 'PONG') {
        throw new Error(`Unexpected Redis PING response: ${String(pingRes)}`);
      }

      // Probe write permission before migrating large datasets so a read-only Upstash token
      // (403 NOPERM) is detected cleanly once without error spam or repeated failed writes.
      try {
        await withUpstashStepRetry('WRITE_PROBE', () => callCloudKvCommand(['SET', '__iluo_write_probe__', '1', 'EX', '10']));
        upstashReadOnlyDetected = false;
        kvWriteDisabled = false;
      } catch (probeErr) {
        if (isPermanentRedisAuthError(probeErr)) {
          upstashReadOnlyDetected = true;
          kvWriteDisabled = true;
          clearUpstashSeedRetryTimer();
          upstashLastSeedError = 'Read-only Upstash Redis token detected (NOPERM on SET). Replace UPSTASH_REDIS_REST_TOKEN with the primary Read-Write token.';
          console.log('[UPSTASH] Connected in read-only mode (NOPERM on SET). Replace UPSTASH_REDIS_REST_TOKEN with the Read-Write token to enable automatic seeding and persistence.');
          return { connected: true, writable: false, skipped: true, seededKeys };
        }
        throw probeErr;
      }

      // 1. yokohama_employees
      const existingEmps = await withUpstashStepRetry('GET_EMPLOYEES', () => syncWithCloudKv('GET', REDIS_KEYS.employees));
      if (!Array.isArray(existingEmps) || existingEmps.length === 0) {
        const localEmps = readLocalSeedEmployees();
        if (localEmps.length > 0) {
          await withUpstashStepRetry('SET_EMPLOYEES', () => persistToCloudKvStrict('SET', REDIS_KEYS.employees, localEmps));
          customEmployeesMemory = localEmps;
          kvCacheTs.employees = Date.now();
          seededKeys.push(REDIS_KEYS.employees);
        }
      }

      // 2. yokohama_records
      const existingRecs = await withUpstashStepRetry('GET_RECORDS', () => syncWithCloudKv('GET', REDIS_KEYS.records));
      const hasRecordsInRedis = existingRecs && typeof existingRecs === 'object' && !existingRecs.error &&
        (existingRecs.__initialized || Object.keys(existingRecs).length > 0);
      if (!hasRecordsInRedis) {
        const localRecs = readLocalSeedRecords();
        const compacted = compactRecordsForCloudKv(localRecs);
        await withUpstashStepRetry('SET_RECORDS', () => persistToCloudKvStrict('SET', REDIS_KEYS.records, compacted));
        globalAssessmentRecords.clear();
        Object.entries(compacted).forEach(([k, v]) => {
          if (k !== '__initialized') globalAssessmentRecords.set(String(k), v);
        });
        globalAssessmentRecords._isExplicitlyCleared = true;
        kvCacheTs.records = Date.now();
        seededKeys.push(REDIS_KEYS.records);
      }

      // 3. yokohama_ojt (preserves legacy yokohama_ojt_evaluations if present)
      const existingOjt = await withUpstashStepRetry('GET_OJT', () => syncWithCloudKv('GET', REDIS_KEYS.ojt));
      const hasOjtInRedis = existingOjt && typeof existingOjt === 'object' && !existingOjt.error &&
        (existingOjt.__initialized || Object.keys(existingOjt).length > 0);
      if (!hasOjtInRedis) {
        const legacyOjt = await withUpstashStepRetry('GET_OJT_LEGACY', () => syncWithCloudKv('GET', REDIS_KEYS.ojtLegacy));
        const hasLegacyOjt = legacyOjt && typeof legacyOjt === 'object' && !legacyOjt.error &&
          (legacyOjt.__initialized || Object.keys(legacyOjt).length > 0);
        const ojtPayload = hasLegacyOjt
          ? { ...legacyOjt, __initialized: true }
          : { ...readLocalSeedOjt(), __initialized: true };
        await withUpstashStepRetry('SET_OJT', () => persistToCloudKvStrict('SET', REDIS_KEYS.ojt, ojtPayload));
        globalOjtEvaluations.clear();
        Object.entries(ojtPayload).forEach(([k, v]) => {
          if (k !== '__initialized') globalOjtEvaluations.set(String(k), v);
        });
        globalOjtEvaluations._isExplicitlyCleared = true;
        kvCacheTs.ojt = Date.now();
        seededKeys.push(REDIS_KEYS.ojt);
      }

      // 4. yokohama_questions (preserves legacy yokohama_question_bank if present)
      const existingQs = await withUpstashStepRetry('GET_QUESTIONS', () => syncWithCloudKv('GET', REDIS_KEYS.questions));
      const hasQsInRedis = existingQs && typeof existingQs === 'object' && !existingQs.error &&
        Object.keys(existingQs).some((k) => Array.isArray(existingQs[k]) && existingQs[k].length > 0);
      if (!hasQsInRedis) {
        const legacyQs = await withUpstashStepRetry('GET_QUESTIONS_LEGACY', () => syncWithCloudKv('GET', REDIS_KEYS.questionsLegacy));
        const hasLegacyQs = legacyQs && typeof legacyQs === 'object' && !legacyQs.error &&
          Object.keys(legacyQs).some((k) => Array.isArray(legacyQs[k]) && legacyQs[k].length > 0);
        const qsPayload = hasLegacyQs ? legacyQs : readLocalSeedQuestions();
        await withUpstashStepRetry('SET_QUESTIONS', () => persistToCloudKvStrict('SET', REDIS_KEYS.questions, qsPayload));
        customQuestionBankMemory = qsPayload;
        kvCacheTs.questions = Date.now();
        seededKeys.push(REDIS_KEYS.questions);
      }

      // 5. yokohama_settings
      const existingSettings = await withUpstashStepRetry('GET_SETTINGS', () => syncWithCloudKv('GET', REDIS_KEYS.settings));
      const hasSettingsInRedis = existingSettings && typeof existingSettings === 'object' && !existingSettings.error &&
        Object.keys(existingSettings).length > 0;
      if (!hasSettingsInRedis) {
        const localSettings = readLocalSeedSettings();
        await withUpstashStepRetry('SET_SETTINGS', () => persistToCloudKvStrict('SET', REDIS_KEYS.settings, localSettings));
        customSettingsMemory = localSettings;
        kvCacheTs.settings = Date.now();
        seededKeys.push(REDIS_KEYS.settings);
      }

      upstashSeedCompleted = true;
      upstashLastSeedError = null;
      clearUpstashSeedRetryTimer();
      if (seededKeys.length > 0) {
        console.log(`✅ [UPSTASH SEED] Automatically migrated local dataset to Upstash Redis keys: ${seededKeys.join(', ')}`);
      }
      return { connected: true, seededKeys };
    } catch (err) {
      upstashLastSeedError = err ? String(err.message || 'Initial seed failed').slice(0, 200) : 'Initial seed failed';
      console.log(`[UPSTASH] Initial Redis migration attempt #${upstashSeedAttempts} deferred: ${upstashLastSeedError}`);
      return { connected: false, transient: !isPermanentRedisAuthError(err), error: upstashLastSeedError, seededKeys };
    } finally {
      upstashSeedPromise = null;
    }
  })();

  return await upstashSeedPromise;
}

// Startup retry scheduler with exponential backoff (2s -> 4s -> 8s -> 16s -> 30s)
// Stops immediately on success, read-only token, or max retries.
function scheduleUpstashStartupMigration(retryIndex = 0) {
  if (!kvUrl || !kvToken || upstashSeedCompleted || upstashReadOnlyDetected) {
    clearUpstashSeedRetryTimer();
    return;
  }
  ensureUpstashInitialSeed()
    .then((result) => {
      if (upstashSeedCompleted || upstashReadOnlyDetected || (result && result.skipped)) {
        clearUpstashSeedRetryTimer();
        return;
      }
      if (retryIndex >= UPSTASH_SEED_STARTUP_MAX_RETRIES) {
        clearUpstashSeedRetryTimer();
        console.log(`[UPSTASH] Startup migration retries exhausted (${UPSTASH_SEED_STARTUP_MAX_RETRIES} retries); will retry lazily on next request.`);
        return;
      }
      const nextRetry = retryIndex + 1;
      const delayMs = Math.min(30000, UPSTASH_SEED_BASE_DELAY_MS * Math.pow(2, retryIndex));
      clearUpstashSeedRetryTimer();
      console.log(`[UPSTASH] Scheduling Redis migration retry ${nextRetry}/${UPSTASH_SEED_STARTUP_MAX_RETRIES} in ${delayMs}ms...`);
      upstashSeedRetryTimer = setTimeout(() => {
        upstashSeedRetryTimer = null;
        scheduleUpstashStartupMigration(nextRetry);
      }, delayMs);
      if (typeof upstashSeedRetryTimer.unref === 'function') {
        upstashSeedRetryTimer.unref();
      }
    })
    .catch(() => {});
}

async function getSettingsAuthoritative() {
  if (kvUrl && kvToken) await ensureUpstashInitialSeed();
  if (customSettingsMemory && (Date.now() - kvCacheTs.settings) < 30000) {
    return { ...DEFAULT_SETTINGS, ...customSettingsMemory };
  }
  if (kvUrl && kvToken) {
    try {
      const cloudSettings = await syncWithCloudKv('GET', REDIS_KEYS.settings);
      if (cloudSettings && typeof cloudSettings === 'object') {
        customSettingsMemory = { ...DEFAULT_SETTINGS, ...cloudSettings };
        kvCacheTs.settings = Date.now();
        return customSettingsMemory;
      }
    } catch (e) {}
  }
  if (!customSettingsMemory && fs.existsSync(SETTINGS_JSON_FILE)) {
    try {
      customSettingsMemory = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_JSON_FILE, 'utf-8')) };
    } catch (e) {}
  }
  return { ...DEFAULT_SETTINGS, ...(customSettingsMemory || {}) };
}

async function saveSettingsAuthoritative(nextSettings) {
  const merged = { ...(await getSettingsAuthoritative()), ...(nextSettings || {}) };
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.settings, merged);
  }
  customSettingsMemory = merged;
  kvCacheTs.settings = Date.now();
  try {
    fs.writeFileSync(SETTINGS_JSON_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {}
  return merged;
}

// Authoritative Employee Store (Redis Primary + JSON/Base Seed Fallback)
async function getAuthoritativeEmployees() {
  const hasRedis = Boolean(kvUrl && kvToken);
  if (hasRedis) await ensureUpstashInitialSeed();
  if (
    customEmployeesMemory &&
    Array.isArray(customEmployeesMemory) &&
    customEmployeesMemory.length >= 1 &&
    (!hasRedis || (Date.now() - kvCacheTs.employees) < 30000)
  ) {
    return customEmployeesMemory;
  }
  if (hasRedis) {
    const cloudEmployees = await syncWithCloudKv('GET', REDIS_KEYS.employees);
    if (cloudEmployees && Array.isArray(cloudEmployees) && cloudEmployees.length >= 1) {
      customEmployeesMemory = cloudEmployees;
      kvCacheTs.employees = Date.now();
      return cloudEmployees;
    }
  }
  const localEmps = readLocalSeedEmployees();
  if (localEmps.length > 0) {
    customEmployeesMemory = localEmps;
    kvCacheTs.employees = Date.now();
    return customEmployeesMemory;
  }
  return customEmployeesMemory || [];
}

async function saveAuthoritativeEmployees(employees) {
  if (!Array.isArray(employees)) return;
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.employees, employees);
  }
  customEmployeesMemory = employees;
  kvCacheTs.employees = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    try {
      fs.writeFileSync(EMPLOYEES_JSON_FILE, JSON.stringify(employees, null, 2), 'utf-8');
    } catch (e) {}
  }
}

// Authoritative Question Bank Store (Redis Primary + JSON/Base Seed Fallback)
async function getAuthoritativeQuestions() {
  const hasRedis = Boolean(kvUrl && kvToken);
  if (hasRedis) await ensureUpstashInitialSeed();
  if (
    customQuestionBankMemory &&
    typeof customQuestionBankMemory === 'object' &&
    Object.keys(customQuestionBankMemory).length > 0 &&
    (Date.now() - kvCacheTs.questions) < 30000
  ) {
    return customQuestionBankMemory;
  }
  if (hasRedis) {
    let cloudQuestions = await syncWithCloudKv('GET', REDIS_KEYS.questions);
    if (!cloudQuestions || typeof cloudQuestions !== 'object' || Object.keys(cloudQuestions).length === 0) {
      cloudQuestions = await syncWithCloudKv('GET', REDIS_KEYS.questionsLegacy);
    }
    if (cloudQuestions && typeof cloudQuestions === 'object' && Object.keys(cloudQuestions).length > 0) {
      customQuestionBankMemory = cloudQuestions;
      kvCacheTs.questions = Date.now();
      return cloudQuestions;
    }
  }
  if (customQuestionBankMemory && typeof customQuestionBankMemory === 'object' && Object.keys(customQuestionBankMemory).length > 0) {
    return customQuestionBankMemory;
  }
  const localQs = readLocalSeedQuestions();
  customQuestionBankMemory = localQs;
  kvCacheTs.questions = Date.now();
  return customQuestionBankMemory;
}

async function saveAuthoritativeQuestions(qb) {
  if (!qb || typeof qb !== 'object') return;
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.questions, qb);
  }
  customQuestionBankMemory = qb;
  kvCacheTs.questions = Date.now();
  const serialized = JSON.stringify(qb, null, 2);
  try {
    fs.writeFileSync(QUESTIONS_JSON_FILE, serialized, 'utf-8');
  } catch (e) {}
  try {
    fs.writeFileSync(MASTER_QUESTIONS_JSON_FILE, serialized, 'utf-8');
  } catch (e) {}
}

// Authoritative Assessment Records Store (Redis Primary + Disk Seed Fallback)
async function getAuthoritativeRecords() {
  const hasRedis = Boolean(kvUrl && kvToken);
  if (hasRedis) await ensureUpstashInitialSeed();
  if ((globalAssessmentRecords.size > 0 || globalAssessmentRecords._isExplicitlyCleared) && (Date.now() - kvCacheTs.records) < 5000) {
    const cached = Object.fromEntries(globalAssessmentRecords);
    delete cached.__initialized;
    return cached;
  }
  if (hasRedis) {
    try {
      const cloudRecords = await syncWithCloudKv('GET', REDIS_KEYS.records);
      if (cloudRecords !== null && typeof cloudRecords === 'object' && !cloudRecords.error) {
        const clean = { ...cloudRecords };
        delete clean.__initialized;
        globalAssessmentRecords.clear();
        Object.entries(clean).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
        globalAssessmentRecords._isExplicitlyCleared = true;
        kvCacheTs.records = Date.now();
        return clean;
      }
    } catch (e) {
      if (isProduction) throw e;
    }
  }
  if (globalAssessmentRecords.size === 0 && !globalAssessmentRecords._isExplicitlyCleared) {
    const parsed = readLocalSeedRecords();
    Object.entries(parsed).forEach(([k, v]) => {
      if (k !== '__initialized') globalAssessmentRecords.set(String(k), v);
    });
  }
  const result = Object.fromEntries(globalAssessmentRecords);
  delete result.__initialized;
  return result;
}

// Compact records map for Upstash Redis storage (strips multi-MB duplicated submittedQuestions text blobs
// while preserving every score, categoryMarks, responses, status, switchedLevel, and attemptHistory)
function compactRecordsForCloudKv(recordsMap) {
  const compact = { __initialized: true };
  for (const [k, v] of Object.entries(recordsMap || {})) {
    if (k === '__initialized') continue;
    if (v && typeof v === 'object') {
      if (Array.isArray(v.submittedQuestions) && v.submittedQuestions.length > 0) {
        const { submittedQuestions, ...rest } = v;
        compact[k] = { ...rest, questionCount: v.questionCount || submittedQuestions.length };
      } else {
        compact[k] = v;
      }
    } else {
      compact[k] = v;
    }
  }
  return compact;
}

async function saveAuthoritativeRecord(empNo, updaterOrData) {
  const strEmpNo = String(empNo).trim();
  const release = await acquireEntityLock(`record:${strEmpNo}`);
  try {
    const currentRecords = await getAuthoritativeRecords();
    const existing = currentRecords[strEmpNo] || {};

    let updatedData;
    if (typeof updaterOrData === 'function') {
      updatedData = updaterOrData(existing);
    } else {
      updatedData = { ...existing, ...updaterOrData };
    }

    updatedData.version = (existing.version || 0) + 1;
    updatedData.updatedAt = new Date().toISOString();

    const nextRecords = { ...currentRecords, [strEmpNo]: updatedData, __initialized: true };
    const compacted = compactRecordsForCloudKv(nextRecords);

    if (kvUrl && kvToken) {
      await persistToCloudKvStrict('SET', REDIS_KEYS.records, compacted);
    }

    globalAssessmentRecords.set(strEmpNo, updatedData);
    globalAssessmentRecords._isExplicitlyCleared = true;
    kvCacheTs.records = Date.now();
    if (process.env.NODE_ENV !== 'test') {
      try {
        fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(compacted, null, 2), 'utf-8');
      } catch (e) {}
    }

    return updatedData;
  } finally {
    release();
  }
}

async function saveAllAuthoritativeRecords(recordsObj) {
  if (!recordsObj || typeof recordsObj !== 'object') return;
  const payload = compactRecordsForCloudKv(recordsObj);

  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.records, payload);
  }

  globalAssessmentRecords.clear();
  Object.entries(payload).forEach(([k, v]) => {
    if (k !== '__initialized') globalAssessmentRecords.set(String(k), v);
  });
  globalAssessmentRecords._isExplicitlyCleared = true;
  kvCacheTs.records = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    try {
      fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {}
  }
}

async function resetAuthoritativeRecords(filterFn = null) {
  if (!filterFn) {
    const emptyPayload = { __initialized: true };
    if (kvUrl && kvToken) {
      await persistToCloudKvStrict('SET', REDIS_KEYS.records, emptyPayload);
    }
    globalAssessmentRecords.clear();
    globalAssessmentRecords._isExplicitlyCleared = true;
    kvCacheTs.records = Date.now();
    activeExamSessions.clear();
    if (process.env.NODE_ENV !== 'test') {
      try {
        fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(emptyPayload, null, 2), 'utf-8');
      } catch (e) {}
    }
    return {};
  }

  const currentRecords = await getAuthoritativeRecords();
  const newRecords = { __initialized: true };
  let resetCount = 0;
  const resetKeys = [];
  for (const [k, v] of Object.entries(currentRecords)) {
    if (k === '__initialized') continue;
    if (filterFn(k, v)) {
      resetCount++;
      resetKeys.push(String(k).trim());
    } else {
      newRecords[k] = v;
    }
  }

  const compacted = compactRecordsForCloudKv(newRecords);
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.records, compacted);
    await Promise.all(resetKeys.map((k) => syncWithCloudKv('DEL', `exam:${k}`).catch(() => {})));
  }

  resetKeys.forEach((k) => activeExamSessions.delete(k));
  globalAssessmentRecords.clear();
  Object.entries(newRecords).forEach(([k, v]) => {
    if (k !== '__initialized') globalAssessmentRecords.set(k, v);
  });
  globalAssessmentRecords._isExplicitlyCleared = true;
  kvCacheTs.records = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    try {
      fs.writeFileSync(RECORDS_JSON_FILE, JSON.stringify(compacted, null, 2), 'utf-8');
    } catch (e) {}
  }

  const cleanRet = { ...newRecords };
  delete cleanRet.__initialized;
  return { newRecords: cleanRet, resetCount };
}

// Authoritative OJT Store (Redis Primary + Disk Seed Fallback)
async function getAuthoritativeOjtEvaluations() {
  const hasRedis = Boolean(kvUrl && kvToken);
  if (hasRedis) await ensureUpstashInitialSeed();
  if ((globalOjtEvaluations.size > 0 || globalOjtEvaluations._isExplicitlyCleared) && (!hasRedis || (Date.now() - kvCacheTs.ojt) < 5000)) {
    const cached = Object.fromEntries(globalOjtEvaluations);
    delete cached.__initialized;
    return cached;
  }
  if (hasRedis) {
    try {
      let cloudOjt = await syncWithCloudKv('GET', REDIS_KEYS.ojt);
      if (!cloudOjt || typeof cloudOjt !== 'object' || cloudOjt.error) {
        cloudOjt = await syncWithCloudKv('GET', REDIS_KEYS.ojtLegacy);
      }
      if (cloudOjt !== null && typeof cloudOjt === 'object' && !cloudOjt.error) {
        const clean = { ...cloudOjt };
        delete clean.__initialized;
        globalOjtEvaluations.clear();
        Object.entries(clean).forEach(([k, v]) => globalOjtEvaluations.set(String(k), v));
        globalOjtEvaluations._isExplicitlyCleared = true;
        kvCacheTs.ojt = Date.now();
        return clean;
      }
    } catch (e) {
      if (isProduction) throw e;
    }
  }
  if (globalOjtEvaluations.size === 0 && !globalOjtEvaluations._isExplicitlyCleared) {
    const parsed = readLocalSeedOjt();
    Object.entries(parsed).forEach(([k, v]) => {
      if (k !== '__initialized') globalOjtEvaluations.set(String(k), v);
    });
  }
  const result = Object.fromEntries(globalOjtEvaluations);
  delete result.__initialized;
  return result;
}

async function saveAuthoritativeOjtEvaluation(empNo, ojtData) {
  const strEmpNo = String(empNo).trim();
  const release = await acquireEntityLock(`ojt:${strEmpNo}`);
  try {
    const current = await getAuthoritativeOjtEvaluations();
    const existing = current[strEmpNo] || {};
    const updated = {
      ...existing,
      ...ojtData,
      version: (existing.version || 0) + 1,
      updatedAt: new Date().toISOString()
    };
    const nextPayload = { ...current, [strEmpNo]: updated, __initialized: true };

    if (kvUrl && kvToken) {
      await persistToCloudKvStrict('SET', REDIS_KEYS.ojt, nextPayload);
    }

    globalOjtEvaluations.set(strEmpNo, updated);
    globalOjtEvaluations._isExplicitlyCleared = true;
    kvCacheTs.ojt = Date.now();
    if (process.env.NODE_ENV !== 'test') {
      try {
        fs.writeFileSync(OJT_JSON_FILE, JSON.stringify(nextPayload, null, 2), 'utf-8');
      } catch (e) {}
    }
    return updated;
  } finally {
    release();
  }
}

async function saveAllAuthoritativeOjtEvaluations(ojtObj) {
  if (!ojtObj || typeof ojtObj !== 'object') return;
  const payload = { ...ojtObj, __initialized: true };

  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.ojt, payload);
  }

  globalOjtEvaluations.clear();
  Object.entries(payload).forEach(([k, v]) => {
    if (k !== '__initialized') globalOjtEvaluations.set(String(k), v);
  });
  globalOjtEvaluations._isExplicitlyCleared = true;
  kvCacheTs.ojt = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    try {
      fs.writeFileSync(OJT_JSON_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {}
  }
}

// Automatic Soft Backup Snapshot Helper (30-min Undo Window, Redis + Memory)
async function getSoftBackupsList() {
  if (kvUrl && kvToken) {
    try {
      const cloudBackups = await syncWithCloudKv('GET', 'yokohama_soft_backups');
      if (Array.isArray(cloudBackups)) {
        softBackupsMemory.clear();
        cloudBackups.forEach((b) => { if (b && b.backupId) softBackupsMemory.set(b.backupId, b); });
        return cloudBackups;
      }
    } catch (e) {}
  }
  return Array.from(softBackupsMemory.values());
}

async function saveSoftBackupsList(list) {
  const trimmed = Array.isArray(list) ? list.slice(-30) : [];
  softBackupsMemory.clear();
  trimmed.forEach((b) => { if (b && b.backupId) softBackupsMemory.set(b.backupId, b); });
  if (kvUrl && kvToken) {
    try { await syncWithCloudKv('SET', 'yokohama_soft_backups', trimmed); } catch (e) {}
  }
}

async function createSoftBackupSnapshot(backupType, actor, summary, snapshot) {
  const backupId = `bkp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const actorStr = typeof actor === 'string' ? actor : ((actor && (actor.email || actor.name)) || 'Admin');
  const undoMinutes = 30;
  const expiresAt = new Date(Date.now() + undoMinutes * 60 * 1000).toISOString();

  const entry = {
    backupId,
    backupType,
    actor: actorStr,
    summary,
    snapshot,
    createdAt: new Date().toISOString(),
    expiresAt,
    restoredAt: null
  };

  const existingList = await getSoftBackupsList();
  existingList.push(entry);
  await saveSoftBackupsList(existingList);
  return { backupId, expiresAt };
}

// Question & Exam Evaluation Helpers
function normalizeSectionNameServer(sec) {
  const s = String(sec || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (PROD_SECTION_KEYS.has(s)) return s;
  return normalizeQaSectionKey(sec);
}

function shuffleArrayServer(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
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
async function scoreAssessmentServerSide(empNo, targetLevel, responses, section, examSession = null) {
  const strEmpNo = String(empNo).trim();
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
  const empSection = section || (emp && emp.section) || '';

  const qBank = await getAuthoritativeQuestions();
  const allLevelQuestions = qBank[targetLevel] || qBank['L'] || [];

  let questions = [];
  if (examSession && Array.isArray(examSession.questionIds) && examSession.questionIds.length > 0) {
    const byId = new Map(allLevelQuestions.map(q => [String(q.id), q]));
    questions = examSession.questionIds.map(id => byId.get(String(id))).filter(Boolean);
  }
  if (questions.length === 0) {
    questions = getQuestionsForSectionServer(allLevelQuestions, targetLevel, empSection);
  }

  let correctCount = 0;
  let safetyMark = 0, safetyTotal = 0;
  let processMark = 0, processTotal = 0;
  let qualityMark = 0, qualityTotal = 0;
  let ciTpmMark = 0, ciTpmTotal = 0;

  const optionMaps = (examSession && examSession.optionMaps) || {};

  const submittedQuestions = questions.map((q, idx) => {
    const rawSel = (responses && responses[q.id] !== undefined && responses[q.id] !== null) ? String(responses[q.id]) : 'Not Answered';
    const qMap = optionMaps[q.id];
    const selKey = (qMap && qMap[rawSel]) ? qMap[rawSel] : rawSel;
    const selOpt = q.options ? q.options.find(o => o.key === selKey) : null;
    const corrOpt = q.options ? q.options.find(o => o.key === q.correctAnswer) : null;
    const isCorrect = (selKey === q.correctAnswer);
    if (isCorrect) correctCount++;

    const cat = (q.category || '').toLowerCase();
    const qText = (q.question || '').toLowerCase();
    if (cat.includes('safety')) {
      safetyTotal++;
      if (isCorrect) safetyMark++;
    } else if (cat.includes('ci') || cat.includes('tpm')) {
      ciTpmTotal++;
      if (isCorrect) ciTpmMark++;
    } else if (cat.includes('quality') || qText.includes('quality') || qText.includes('defect') || qText.includes('inspect') || qText.includes('standard') || qText.includes('spec') || qText.includes('tolerance') || qText.includes('scrap') || qText.includes('check') || qText.includes('sample') || qText.includes('audit')) {
      qualityTotal++;
      if (isCorrect) qualityMark++;
    } else {
      processTotal++;
      if (isCorrect) processMark++;
    }

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

  const settings = await getSettingsAuthoritative();
  const passingPct = Number(settings.examPassingPct || 50);

  const totalQs = questions.length || 1;
  const markPct = Math.round((correctCount / totalQs) * 100);
  const currentLevel = (emp && emp.currentLevel) || 'I';
  const pass = markPct >= passingPct;

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
    passingPctUsed: passingPct,
    safetyMark,
    safetyTotal,
    processMark,
    processTotal,
    qualityMark,
    qualityTotal,
    ciTpmMark,
    ciTpmTotal,
    status: pass ? 'Passed' : 'Failed',
    isPassed: pass,
    score: correctCount,
    totalQuestions: totalQs,
    percentage: markPct,
    categoryMarks: {
      safety: safetyMark,
      quality: qualityMark,
      process: processMark,
      ciTpm: ciTpmMark
    },
    scheduleId: (examSession && examSession.scheduleId) || null,
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

// DELETE /api/records/:empNo (Admin: Reset specific candidate with automatic soft backup)
app.delete('/api/records/:empNo', requireAdminAuth, async (req, res) => {
  const strEmpNo = String(req.params.empNo).trim();
  const current = await getAuthoritativeRecords();
  const prev = current[strEmpNo];
  let backup = null;
  if (prev) {
    backup = await createSoftBackupSnapshot('SINGLE_RECORD_RESET', req.authUser, `Reset record for ${strEmpNo}`, { records: { [strEmpNo]: prev } });
  }
  await resetAuthoritativeRecords((k) => k === strEmpNo);
  await logAuditEvent('RESET_SINGLE_RECORD', req.authUser, `Reset exam record for ${strEmpNo}`, req, strEmpNo);
  res.json({ success: true, message: `Record reset for employee ${strEmpNo}`, ...(backup || {}) });
});

// POST /api/records/reset-all (Superadmin only: Typed confirmation + Automatic Backup + 30m Undo)
app.post('/api/records/reset-all', requireSuperAdminAuth, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'RESET-ALL-EXAMS') {
    return res.status(400).json({
      success: false,
      message: 'Confirmation phrase mismatch. You must explicitly type "RESET-ALL-EXAMS" to perform this action.'
    });
  }

  const snapshotRecords = await getAuthoritativeRecords();
  const count = Object.keys(snapshotRecords || {}).length;
  const backup = await createSoftBackupSnapshot('RESET_ALL_EXAMS', req.authUser, `Full exam reset (${count} records)`, { records: snapshotRecords });

  await resetAuthoritativeRecords(null);
  await logAuditEvent('RESET_ALL_EXAMS', req.authUser, `Reset all assessment records (${count}) to zero finished (Backup ${backup.backupId})`, req, 'ALL_RECORDS');
  res.json({
    success: true,
    message: `All exam records reset to zero. Undo available for 30 minutes.`,
    backupId: backup.backupId,
    undoExpiresAt: backup.expiresAt
  });
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
  const snapshotRecords = await getAuthoritativeRecords();
  const backup = await createSoftBackupSnapshot('DELETE_ALL_RECORDS', req.authUser, 'Deleted all assessment records', { records: snapshotRecords });
  await resetAuthoritativeRecords(null);
  await logAuditEvent('DELETE_ALL_RECORDS', req.authUser, `Deleted all assessment records (Backup ${backup.backupId})`, req, 'ALL_RECORDS');
  res.json({ success: true, message: 'All exam records reset to zero', backupId: backup.backupId, undoExpiresAt: backup.expiresAt });
});

// POST /api/records/reset-section (Admin only + Soft Backup + Audit)
app.post('/api/records/reset-section', requireAdminAuth, async (req, res) => {
  const { section, sectionId } = req.body || {};
  if (!section && !sectionId) {
    return res.status(400).json({ success: false, message: 'section or sectionId is required' });
  }

  const emps = await getAuthoritativeEmployees();
  const secQuery = normalizeSectionNameServer(section || sectionId);
  const isProdSecQuery = PROD_SECTION_KEYS.has(secQuery);
  const currentRecords = await getAuthoritativeRecords();

  const sectionEmpNos = new Set();
  const affectedRecords = {};
  emps.forEach(emp => {
    const empSec = normalizeSectionNameServer(emp.section);
    const matches = isProdSecQuery
      ? empSec === secQuery
      : (empSec === secQuery || empSec.includes(secQuery) || secQuery.includes(empSec));
    if (matches) {
      const k = String(emp.empNo).trim();
      sectionEmpNos.add(k);
      if (currentRecords[k]) affectedRecords[k] = currentRecords[k];
    }
  });

  const backup = await createSoftBackupSnapshot('RESET_SECTION_EXAMS', req.authUser, `Section reset: ${section || sectionId} (${Object.keys(affectedRecords).length} records)`, { records: affectedRecords });
  const result = await resetAuthoritativeRecords((k) => sectionEmpNos.has(k));
  await logAuditEvent('RESET_SECTION_EXAMS', req.authUser, `Reset ${result.resetCount} exam records in section ${section || sectionId}`, req, String(section || sectionId));

  res.json({
    success: true,
    message: `Successfully reset exams for section ${section || sectionId}`,
    count: result.resetCount,
    records: result.newRecords,
    backupId: backup.backupId,
    undoExpiresAt: backup.expiresAt
  });
});

// POST /api/records/reset-department (Admin or Department HOD + Soft Backup + Audit)
app.post('/api/records/reset-department', async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, authenticated: false, message: 'Unauthorized: Authentication required' });
  }

  const { department } = req.body || {};
  if (!department) {
    return res.status(400).json({ success: false, message: 'department is required' });
  }

  const deptQuery = normalizeDepartmentName(department).toLowerCase();

  // If role is DEPT_HEAD, ensure they only reset their assigned department
  if (user.role === 'DEPT_HEAD') {
    const userDept = normalizeDepartmentName(user.department || user.dept || '').toLowerCase();
    if (userDept !== deptQuery) {
      return res.status(403).json({ success: false, message: 'Forbidden: HOD can only reset their assigned department' });
    }
  } else if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Administrator or Department HOD privileges required' });
  }

  const emps = await getAuthoritativeEmployees();
  const currentRecords = await getAuthoritativeRecords();

  const deptEmpNos = new Set();
  const affectedRecords = {};
  emps.forEach(emp => {
    const empDept = normalizeDepartmentName(emp.dept || 'QUALITY CONTROL').toLowerCase();
    if (deptQuery === 'all' || empDept === deptQuery || empDept.includes(deptQuery) || deptQuery.includes(empDept)) {
      const k = String(emp.empNo).trim();
      deptEmpNos.add(k);
      if (currentRecords[k]) affectedRecords[k] = currentRecords[k];
    }
  });

  const isQcQuery = deptQuery.includes('quality') || deptQuery.includes('qc');
  for (const [k, r] of Object.entries(currentRecords)) {
    if (k === '__initialized' || deptEmpNos.has(k)) continue;
    const rDept = normalizeDepartmentName(r.dept || '').toLowerCase();
    const rSec = (r.section || '').toLowerCase();
    if (deptQuery === 'all' || rDept === deptQuery || rDept.includes(deptQuery) || (isQcQuery && (rSec.includes('qa') || rDept.includes('qc') || rDept.includes('quality')))) {
      deptEmpNos.add(String(k).trim());
      affectedRecords[k] = r;
    }
  }

  const backup = await createSoftBackupSnapshot('RESET_DEPT_EXAMS', user, `Department reset: ${department} (${Object.keys(affectedRecords).length} records)`, { records: affectedRecords });
  const result = await resetAuthoritativeRecords((k) => deptEmpNos.has(k));
  await logAuditEvent('RESET_DEPT_EXAMS', user, `Reset ${result.resetCount} exam records in department ${department}`, req, String(department));

  res.json({
    success: true,
    message: `Successfully reset exams for department ${department}`,
    count: result.resetCount,
    records: result.newRecords,
    backupId: backup.backupId,
    undoExpiresAt: backup.expiresAt
  });
});

// POST /api/records/restore-demo (Disabled in Production; use Soft Backup Undo instead)
app.post('/api/records/restore-demo', requireSuperAdminAuth, async (req, res) => {
  if (isProduction && process.env.ALLOW_DEMO_RESTORE !== 'true') {
    return res.status(410).json({
      success: false,
      message: 'Restore Demo is disabled in production. Use Soft Backups & 30-Minute Undo instead.'
    });
  }
  const BACKUP_FILE = path.join(__dirname, 'assessment_records_backup_236.json');
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      globalAssessmentRecords.clear();
      Object.entries(parsed).forEach(([k, v]) => globalAssessmentRecords.set(String(k), v));
      if (kvUrl && kvToken) {
        await persistToCloudKvStrict('SET', REDIS_KEYS.records, compactRecordsForCloudKv(parsed));
      }
      await logAuditEvent('RESTORE_DEMO_RECORDS', req.authUser, `Restored ${globalAssessmentRecords.size} demo records`, req);
      return res.json({ success: true, message: `Restored ${globalAssessmentRecords.size} demo records from backup`, records: parsed });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to restore backup: ' + err.message });
    }
  }
  return res.status(404).json({ success: false, message: 'Backup file assessment_records_backup_236.json not found' });
});

// Soft Backups & 30-Minute Undo API
app.get('/api/admin/backups', requireAdminAuth, async (req, res) => {
  const now = Date.now();
  const list = await getSoftBackupsList();
  const active = list
    .filter((b) => b && !b.restoredAt && new Date(b.expiresAt).getTime() > now)
    .reverse();
  return res.json({ success: true, backups: active });
});

app.post('/api/admin/backups/:backupId/undo', requireAdminAuth, async (req, res) => {
  const backupId = String(req.params.backupId || '').trim();
  const list = await getSoftBackupsList();
  const bkp = list.find((b) => b && b.backupId === backupId) || softBackupsMemory.get(backupId) || null;
  if (!bkp) {
    return res.status(404).json({ success: false, message: 'Backup snapshot not found' });
  }
  if (bkp.restoredAt) {
    return res.status(409).json({ success: false, message: 'This backup snapshot was already restored.' });
  }
  if (Date.now() > new Date(bkp.expiresAt).getTime()) {
    return res.status(410).json({ success: false, message: '30-minute undo window has expired for this backup.' });
  }

  const snap = bkp.snapshot || {};
  let restoredCount = 0;

  if (snap.records && typeof snap.records === 'object') {
    for (const [k, rec] of Object.entries(snap.records)) {
      if (k !== '__initialized' && rec && typeof rec === 'object') {
        await saveAuthoritativeRecord(k, rec);
        restoredCount++;
      }
    }
    await saveSettingsAuthoritative({ __recordsCleared: false });
  }
  if (snap.ojt && typeof snap.ojt === 'object') {
    for (const [k, ojt] of Object.entries(snap.ojt)) {
      if (k !== '__initialized' && ojt && typeof ojt === 'object') {
        await saveAuthoritativeOjtEvaluation(k, ojt);
        restoredCount++;
      }
    }
    await saveSettingsAuthoritative({ __ojtCleared: false });
  }
  if (snap.deletedEmployee && snap.deletedEmployee.empNo) {
    const emps = await getAuthoritativeEmployees();
    if (!emps.some((e) => String(e.empNo) === String(snap.deletedEmployee.empNo))) {
      emps.push(snap.deletedEmployee);
      await saveAuthoritativeEmployees(emps);
    }
    restoredCount++;
  }
  if (snap.questionBank && typeof snap.questionBank === 'object') {
    await saveAuthoritativeQuestions(snap.questionBank);
    restoredCount++;
  }

  bkp.restoredAt = new Date().toISOString();
  await saveSoftBackupsList(list);

  await logAuditEvent('UNDO_BACKUP_RESTORE', req.authUser, `Restored backup ${backupId} (${bkp.backupType}, ${restoredCount} items)`, req, backupId);
  return res.json({ success: true, message: `Restored ${restoredCount} item(s) from safety backup.`, restoredCount });
});

// ---------------------------------------------------------------------
// SERVER-SIDE EXAM LIFECYCLE & SUBMISSION API (Anti-Cheat, Shuffle & Duration)
// ---------------------------------------------------------------------

app.post('/api/exam/start', requireEmpAuth, async (req, res) => {
  try {
    const user = req.authUser;
    const empNo = req.body.empNo || user.empNo;
    const strEmpNo = String(empNo).trim();
    const scheduleId = req.body.scheduleId ? String(req.body.scheduleId).trim() : null;

    if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only start an exam for your own employee ID' });
    }

    const [employees, records, settings, qBank] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getSettingsAuthoritative(),
      getAuthoritativeQuestions()
    ]);

    const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
    if (!emp) {
      return res.status(404).json({ success: false, message: `Employee ID ${strEmpNo} not found in directory` });
    }

    const existingRecord = records[strEmpNo];

    // Enforce one attempt per active schedule if a schedule is specified
    if (scheduleId && existingRecord && Array.isArray(existingRecord.attemptHistory)) {
      const alreadyAttemptedSchedule = existingRecord.attemptHistory.some((h) => h.scheduleId === scheduleId);
      if (alreadyAttemptedSchedule && user.role !== 'SUPERADMIN') {
        return res.status(409).json({
          success: false,
          message: 'One attempt per scheduled assessment allowed. You have already completed this schedule.',
          record: existingRecord
        });
      }
    }

    if (existingRecord && existingRecord.isCompleted) {
      if (user.role === 'SUPERADMIN' || req.body.forceRetake) {
        // Clear any stale in-memory active session; saveAuthoritativeRecord below atomically resets isCompleted=false in a single write
        activeExamSessions.delete(strEmpNo);
      } else {
        return res.status(409).json({
          success: false,
          message: 'Assessment already completed. Contact administrator to reset your exam.',
          record: existingRecord
        });
      }
    }

    const targetLevel = req.body.targetLevel || emp.targetLevel || 'L';
    const allQs = qBank[targetLevel] || qBank['L'] || [];
    const selectedQuestions = getQuestionsForSectionServer(allQs, targetLevel, emp.section);

    // Server-side Fisher-Yates question shuffle
    const shuffledQuestions = shuffleArrayServer(selectedQuestions);
    const shouldShuffleOptions = (process.env.NODE_ENV !== 'test' || req.body.shuffleOptions === true);
    const optionMaps = {};
    const displayQuestions = shuffledQuestions.map((q) => {
      const origOptions = Array.isArray(q.options) ? q.options : [];
      if (!shouldShuffleOptions || origOptions.length < 2) {
        optionMaps[q.id] = {};
        origOptions.forEach((o) => { optionMaps[q.id][o.key] = o.key; });
        return q;
      }
      const keys = origOptions.map((o) => o.key);
      const shuffledOpts = shuffleArrayServer(origOptions);
      const mapForQ = {};
      const remappedOptions = shuffledOpts.map((opt, idx) => {
        const displayKey = keys[idx] || String.fromCharCode(65 + idx);
        mapForQ[displayKey] = opt.key;
        return { key: displayKey, text: opt.text };
      });
      optionMaps[q.id] = mapForQ;
      return { ...q, options: remappedOptions };
    });

    const durationMinutes = Number(settings.examDurationMinutes || 45);
    const durationSeconds = durationMinutes * 60;
    const expiresAt = Date.now() + (durationSeconds * 1000) + 30000;

    const examSession = {
      empNo: strEmpNo,
      targetLevel,
      scheduleId,
      questionIds: displayQuestions.map((q) => String(q.id)),
      optionMaps,
      tabSwitchCount: 0,
      startTime: Date.now(),
      expiresAt,
      durationSeconds,
      isCompleted: false
    };

    activeExamSessions.set(strEmpNo, examSession);
    const persistTasks = [
      saveAuthoritativeRecord(strEmpNo, (prev) => ({
        ...(prev || {}),
        empNo: strEmpNo,
        name: emp.name,
        dept: emp.dept,
        section: emp.section,
        doj: emp.doj,
        targetLevel,
        scheduleId,
        inProgress: true,
        isCompleted: false,
        remainingSeconds: durationSeconds,
        currentIndex: 0,
        responses: {},
        tabSwitchCount: 0,
        startedAt: new Date().toISOString()
      }))
    ];
    if (kvUrl && kvToken) {
      persistTasks.push(
        persistToCloudKvStrict('SET', `exam:${strEmpNo}`, examSession, durationSeconds + 120)
      );
    }
    await Promise.all(persistTasks);

    const sanitizedQuestions = sanitizeQuestionsForEmployee(displayQuestions);

    return res.json({
      success: true,
      message: 'Assessment session started',
      activeExam: {
        empNo: strEmpNo,
        targetLevel,
        scheduleId,
        questions: sanitizedQuestions,
        durationSeconds,
        expiresAt,
        maxTabSwitches: Number(settings.maxTabSwitches || 3),
        tabSwitchAction: settings.tabSwitchAction || 'terminate',
        examPassingPct: Number(settings.examPassingPct || 50)
      }
    });
  } catch (err) {
    console.error('Exam start error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start exam session: ' + err.message });
  }
});

// POST /api/exam/tab-switch: Server-Authoritative Anti-Cheat Tab Switch Tracker
app.post('/api/exam/tab-switch', requireEmpAuth, async (req, res) => {
  const user = req.authUser;
  const strEmpNo = String((req.body && req.body.empNo) || user.empNo || '').trim();
  if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  let newCount = null;
  let memSess = activeExamSessions.get(strEmpNo);
  if (!memSess && kvUrl && kvToken) {
    memSess = await syncWithCloudKv('GET', `exam:${strEmpNo}`);
    if (memSess) activeExamSessions.set(strEmpNo, memSess);
  }
  if (memSess) {
    memSess.tabSwitchCount = (memSess.tabSwitchCount || 0) + 1;
    newCount = memSess.tabSwitchCount;
    if (kvUrl && kvToken) {
      await syncWithCloudKv('SET', `exam:${strEmpNo}`, memSess, (memSess.durationSeconds || 2700) + 120).catch(() => {});
    }
  }

  const updatedRec = await saveAuthoritativeRecord(strEmpNo, (existing) => {
    const count = newCount !== null ? newCount : ((existing.tabSwitchCount || 0) + 1);
    return { ...existing, tabSwitchCount: count };
  });

  const settings = await getSettingsAuthoritative();
  const maxTabSwitches = Number(settings.maxTabSwitches || 3);
  const tabCount = updatedRec.tabSwitchCount || newCount || 1;

  await logAuditEvent('EXAM_TAB_SWITCH', strEmpNo, `Tab switch #${tabCount}/${maxTabSwitches}`, req, strEmpNo);

  return res.json({
    success: true,
    tabSwitchCount: tabCount,
    maxTabSwitches,
    action: settings.tabSwitchAction || 'terminate',
    limitReached: tabCount >= maxTabSwitches
  });
});

// POST /api/exam/submit: Server-Side Scoring, Timing Validation & Single Submission Enforcement
app.post('/api/exam/submit', requireEmpAuth, async (req, res) => {
  try {
    const user = req.authUser;
    const { empNo, targetLevel } = req.body || {};
    const responses = (req.body && (req.body.responses || req.body.answers)) || {};
    const strEmpNo = String(empNo || user.empNo).trim();

    if (user.role === 'emp' && String(user.empNo).trim() !== strEmpNo) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only submit your own assessment' });
    }

    const records = await getAuthoritativeRecords();
    const existing = records[strEmpNo];
    if (existing && existing.isCompleted) {
      return res.status(409).json({ success: false, message: 'Conflict: Assessment has already been submitted and completed.' });
    }

    // Check active exam session from memory or Redis
    let examSession = activeExamSessions.get(strEmpNo) || null;
    if (!examSession && kvUrl && kvToken) {
      examSession = await syncWithCloudKv('GET', `exam:${strEmpNo}`);
    }

    if (examSession && examSession.expiresAt && Date.now() > (examSession.expiresAt + 15000)) {
      console.warn(`Assessment submission for ${strEmpNo} arrived after server expiration.`);
    }

    const employees = await getAuthoritativeEmployees();
    const emp = employees.find(e => String(e.empNo).trim().toLowerCase() === strEmpNo.toLowerCase());
    const section = (emp && emp.section) || (existing && existing.section) || '';
    const lvl = targetLevel || (examSession && examSession.targetLevel) || (existing && existing.targetLevel) || (emp && emp.targetLevel) || 'L';

    const scoredRecord = await scoreAssessmentServerSide(strEmpNo, lvl, responses || {}, section, examSession);
    scoredRecord.tabSwitchCount = Math.max(
      Number((existing && existing.tabSwitchCount) || 0),
      Number((examSession && examSession.tabSwitchCount) || 0),
      Number((req.body && req.body.tabSwitchCount) || 0)
    );

    const prevHistory = (existing && Array.isArray(existing.attemptHistory)) ? existing.attemptHistory : [];
    scoredRecord.attemptHistory = [
      ...prevHistory.slice(-9),
      {
        date: scoredRecord.attemptDate,
        timestamp: new Date().toISOString(),
        targetLevel: scoredRecord.targetLevel,
        score: scoredRecord.totalMark,
        totalQuestions: scoredRecord.totalQuestions,
        markPct: scoredRecord.markPct,
        status: scoredRecord.status,
        scheduleId: scoredRecord.scheduleId || null
      }
    ];

    const candidateSignature = (req.body && (req.body.candidateSignature || req.body.signature)) || '';
    if (candidateSignature && String(candidateSignature).startsWith('data:image/')) {
      scoredRecord.candidateSignature = String(candidateSignature).slice(0, 120000);
    }

    if (scoredRecord.isPassed) {
      if (emp) {
        const prevLevel = emp.currentLevel || 'I';
        emp.currentLevel = lvl;
        await saveAuthoritativeEmployees(employees);
        await logAuditEvent('LEVEL_PROMOTION', emp.empNo, `Skill level switched from ${prevLevel} to ${lvl} upon exam completion (${scoredRecord.markPct}%)`, req, emp.empNo);
      }
      scoredRecord.currentLevel = lvl;
      scoredRecord.switchedLevel = lvl;
      if (user && user.role === 'emp') {
        user.currentLevel = lvl;
        const sessionToken = req.signedCookies.emp_session || req.cookies.emp_session || req.headers['x-emp-token'] || req.headers['x-session-token'];
        if (sessionToken) {
          await setCloudSession(sessionToken, user, 28800);
        }
      }
    } else {
      scoredRecord.currentLevel = (emp && emp.currentLevel) || 'I';
    }

    await saveAuthoritativeRecord(strEmpNo, scoredRecord);

    activeExamSessions.delete(strEmpNo);
    if (kvUrl && kvToken) {
      try {
        await syncWithCloudKv('DEL', `exam:${strEmpNo}`);
      } catch (kvErr) {}
    }

    await logAuditEvent('EXAM_SUBMIT', strEmpNo, `Level ${lvl} exam submitted: ${scoredRecord.totalMark}/${scoredRecord.totalQuestions} (${scoredRecord.markPct}%) - ${scoredRecord.status}`, req, strEmpNo);

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

  if (user && ['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return res.json({ success: true, questionBank: qBank });
  }

  // Strip correct answers for candidate / unauthenticated view
  const sanitizedBank = {};
  for (const [lvl, qs] of Object.entries(qBank)) {
    sanitizedBank[lvl] = sanitizeQuestionsForEmployee(qs);
  }

  return res.json({ success: true, questionBank: sanitizedBank });
});

// POST /api/questions: Admin only (+ Automatic Backup + Audit Log)
app.post('/api/questions', requireAdminAuth, async (req, res) => {
  const { questionBank } = req.body;
  if (!questionBank || typeof questionBank !== 'object') {
    return res.status(400).json({ success: false, message: 'questionBank object required' });
  }

  const prevQb = await getAuthoritativeQuestions();
  await createSoftBackupSnapshot('QUESTION_BANK_UPDATE', req.authUser, 'Updated question bank', { questionBank: prevQb });
  await saveAuthoritativeQuestions(questionBank);
  await logAuditEvent('UPDATE_QUESTION_BANK', req.authUser, 'Updated question bank', req, 'QUESTION_BANK');
  return res.json({ success: true, message: 'Question Bank updated and synced permanently!' });
});

app.delete('/api/questions/:id', requireAdminAuth, async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  if (!targetId) return res.status(400).json({ success: false, message: 'Question ID required' });
  const qb = await getAuthoritativeQuestions();
  await createSoftBackupSnapshot('QUESTION_DELETE', req.authUser, `Deleted question ${targetId}`, { questionBank: qb });
  let removed = false;
  for (const lvl of Object.keys(qb)) {
    if (Array.isArray(qb[lvl])) {
      const before = qb[lvl].length;
      qb[lvl] = qb[lvl].filter((q) => String(q.id) !== targetId);
      if (qb[lvl].length < before) removed = true;
    }
  }
  if (!removed) return res.status(404).json({ success: false, message: 'Question not found' });
  await saveAuthoritativeQuestions(qb);
  await logAuditEvent('DELETE_QUESTION', req.authUser, `Deleted question ${targetId}`, req, targetId);
  return res.json({ success: true, message: `Question ${targetId} deleted` });
});

app.post('/api/questions/import', requireAdminAuth, async (req, res) => {
  const { items, replaceLevel } = req.body || {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 2000) {
    return res.status(400).json({ success: false, message: 'Provide 1 to 2000 valid question items' });
  }
  const qb = await getAuthoritativeQuestions();
  await createSoftBackupSnapshot('QUESTIONS_BULK_IMPORT', req.authUser, `Bulk imported ${items.length} questions`, { questionBank: qb });

  let added = 0;
  let updated = 0;
  const errors = [];
  if (replaceLevel && ['L', 'U', 'O'].includes(String(replaceLevel).toUpperCase())) {
    qb[String(replaceLevel).toUpperCase()] = [];
  }
  items.forEach((raw, idx) => {
    const lvl = String(raw.level || 'L').toUpperCase();
    if (!['L', 'U', 'O'].includes(lvl)) { errors.push(`Row ${idx + 1}: Invalid level "${lvl}"`); return; }
    const text = String(raw.question || '').trim();
    if (!text) { errors.push(`Row ${idx + 1}: Question text required`); return; }
    const opts = Array.isArray(raw.options) && raw.options.length >= 2
      ? raw.options.map((o, oi) => ({ key: String(o.key || String.fromCharCode(65 + oi)).toUpperCase(), text: String(o.text || '').trim() }))
      : [
          { key: 'A', text: String(raw.optionA || '').trim() },
          { key: 'B', text: String(raw.optionB || '').trim() },
          { key: 'C', text: String(raw.optionC || '').trim() },
          { key: 'D', text: String(raw.optionD || '').trim() }
        ].filter((o) => o.text);
    if (opts.length < 2) { errors.push(`Row ${idx + 1}: At least 2 options required`); return; }
    const correctAnswer = String(raw.correctAnswer || 'A').toUpperCase();
    const id = String(raw.id || `${lvl}_${Date.now()}_${idx}`).trim();
    const section = canonicalQaSectionName(raw.section || 'Warehouse QA');
    const category = String(raw.category || 'Quality').trim();

    if (!qb[lvl]) qb[lvl] = [];
    const existingIdx = qb[lvl].findIndex((q) => String(q.id) === id);
    const cleanQ = { id, level: lvl, section, category, question: text, options: opts, correctAnswer };
    if (existingIdx >= 0) { qb[lvl][existingIdx] = cleanQ; updated++; }
    else { qb[lvl].push(cleanQ); added++; }
  });

  await saveAuthoritativeQuestions(qb);
  await logAuditEvent('BULK_IMPORT_QUESTIONS', req.authUser, `Imported ${added} new, updated ${updated} questions`, req, 'QUESTION_BANK');
  return res.json({ success: true, added, updated, errors, total: added + updated });
});

// ---------------------------------------------------------------------
// EMPLOYEE DIRECTORY API
// ---------------------------------------------------------------------

// GET /api/employees: Public directory listing (safe fields without passwordHash)
// Excludes Left/Inactive employees by default so active headcount stays accurate; pass ?includeLeft=true to include them.
app.get('/api/employees', requireAnyAuth, async (req, res) => {
  const allEmployees = await getAuthoritativeEmployees();
  const includeLeft = String(req.query.includeLeft || '').toLowerCase() === 'true';
  const leftCount = allEmployees.filter(e => e.isLeft || e.status === 'LEFT').length;
  const filtered = includeLeft
    ? allEmployees
    : allEmployees.filter(e => !e.isLeft && e.status !== 'LEFT');

  const safeEmployees = filtered.map(e => ({
    empNo: e.empNo,
    name: e.name,
    dept: e.dept,
    section: e.section,
    templateSection: e.templateSection,
    qaTemplateSection: e.qaTemplateSection,
    qualification: e.qualification,
    doj: e.doj,
    assessmentDate: e.assessmentDate,
    expCount: e.expCount,
    yearExp: e.yearExp,
    currentLevel: e.currentLevel,
    targetLevel: e.targetLevel,
    eligibleLevel: e.eligibleLevel || e.targetLevel,
    skillLevelAssess2025: e.skillLevelAssess2025,
    skillLevelExpBased: e.skillLevelExpBased,
    afterEvaluationLevel: e.afterEvaluationLevel,
    excelQuestMarks: e.excelQuestMarks,
    excelGembaMarks: e.excelGembaMarks,
    excelOverallResult: e.excelOverallResult,
    recheck: e.recheck,
    isLeft: Boolean(e.isLeft || e.status === 'LEFT'),
    status: (e.isLeft || e.status === 'LEFT') ? 'LEFT' : 'ACTIVE'
  }));
  res.json({ success: true, employees: safeEmployees, activeCount: allEmployees.length - leftCount, leftCount });
});

// Helper to resolve uploaded Excel buffer from base64 payload or stored master template
function resolveExcelSyncBuffer(body) {
  const engine = getExcelSyncEngine();
  const { fileBase64, useStoredTemplate, fileType } = body || {};
  if (useStoredTemplate === 'production') {
    if (!fs.existsSync(engine.PRODUCTION_TEMPLATE_PATH)) {
      throw Object.assign(new Error('Stored Production template not found'), { statusCode: 404 });
    }
    return { buffer: fs.readFileSync(engine.PRODUCTION_TEMPLATE_PATH), forcedType: 'production' };
  }
  if (useStoredTemplate === 'qa') {
    if (!fs.existsSync(engine.QA_TEMPLATE_PATH)) {
      throw Object.assign(new Error('Stored QA template not found'), { statusCode: 404 });
    }
    return { buffer: fs.readFileSync(engine.QA_TEMPLATE_PATH), forcedType: 'qa' };
  }
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw Object.assign(new Error('Uploaded Excel file (.xlsx) base64 payload is required'), { statusCode: 400 });
  }
  const cleanB64 = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
  const buffer = Buffer.from(cleanB64, 'base64');
  if (buffer.length < 100 || buffer.length > 20 * 1024 * 1024) {
    throw Object.assign(new Error('Excel file size must be between 100 bytes and 20 MB'), { statusCode: 400 });
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw Object.assign(new Error('Invalid .xlsx file format (missing ZIP/OpenXML header)'), { statusCode: 400 });
  }
  return { buffer, forcedType: fileType || 'auto' };
}

// POST /api/excel-sync/preview: Parse Production or QA workbook & return validation/upsert diff without committing
app.post('/api/excel-sync/preview', requireAdminAuth, async (req, res) => {
  try {
    const engine = getExcelSyncEngine();
    const { buffer, forcedType } = resolveExcelSyncBuffer(req.body);
    const parsed = await engine.parseUploadedWorkbook(buffer, forcedType);
    const [employees, records, ojt] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);
    const plan = engine.buildWorkbookSyncPlan(parsed, employees, records, ojt);
    return res.json({ success: true, preview: plan.summary });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({ success: false, message: err.message || 'Failed to parse uploaded Excel workbook' });
  }
});

// POST /api/excel-sync/commit: Commit Production or QA workbook upsert into Redis + JSON stores (with 30-min undo backup)
app.post('/api/excel-sync/commit', requireAdminAuth, async (req, res) => {
  try {
    const engine = getExcelSyncEngine();
    const { buffer, forcedType } = resolveExcelSyncBuffer(req.body);
    const parsed = await engine.parseUploadedWorkbook(buffer, forcedType);
    const [employees, records, ojt] = await Promise.all([
      getAuthoritativeEmployees(),
      getAuthoritativeRecords(),
      getAuthoritativeOjtEvaluations()
    ]);

    const plan = engine.buildWorkbookSyncPlan(parsed, employees, records, ojt);
    const backup = await createSoftBackupSnapshot(
      'EXCEL_MASTER_SYNC',
      req.authUser,
      `Synced ${plan.summary.fileType.toUpperCase()} workbook (${plan.summary.matchedUpdated} updated, ${plan.summary.newEmployeesAdded} new, ${plan.summary.leftMarkedInactive} left)`,
      { employees, records, ojtEvaluations: ojt }
    );

    await saveAuthoritativeEmployees(plan.nextEmployees);
    await saveAllAuthoritativeRecords(plan.nextRecords);
    await saveAllAuthoritativeOjtEvaluations(plan.nextOjt);

    await logAuditEvent(
      'EXCEL_MASTER_SYNC',
      req.authUser,
      `Committed ${plan.summary.fileType.toUpperCase()} master Excel sync: ${plan.summary.matchedUpdated} updated, ${plan.summary.newEmployeesAdded} added, ${plan.summary.leftMarkedInactive} left, ${plan.summary.marksUpdatedCount} marks synced`,
      req,
      'EXCEL_SYNC'
    );

    return res.json({
      success: true,
      message: `${plan.summary.fileType.toUpperCase()} Excel data synced successfully!`,
      summary: plan.summary,
      backupId: backup.backupId
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return res.status(status).json({ success: false, message: err.message || 'Failed to commit Excel sync' });
  }
});

// POST /api/employees: Admin only (Scoped/Logged)
app.post('/api/employees', requireAdminAuth, async (req, res) => {
  const { employees } = req.body;
  if (!employees || !Array.isArray(employees)) {
    return res.status(400).json({ success: false, message: 'Array of employees required' });
  }

  await saveAuthoritativeEmployees(employees);
  await logAuditEvent('UPDATE_EMPLOYEE_DIRECTORY', req.authUser, `Updated employee directory (${employees.length} employees)`, req, 'EMPLOYEES');
  res.json({ success: true, message: 'Employee directory updated and persisted!' });
});

// POST /api/employees/import: Bulk Validated Employee Import (with preview count & errors)
app.post('/api/employees/import', requireAdminAuth, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 5000) {
    return res.status(400).json({ success: false, message: 'Provide 1 to 5000 valid employee rows' });
  }
  const employees = await getAuthoritativeEmployees();
  const byNo = new Map(employees.map((e, i) => [String(e.empNo).trim().toLowerCase(), i]));
  let added = 0, updated = 0;
  const errors = [];

  items.forEach((row, idx) => {
    const empNo = String(row.empNo || '').trim();
    const name = String(row.name || '').trim();
    if (!empNo || !name) {
      errors.push(`Row ${idx + 1}: empNo and name are required`);
      return;
    }
    const cleanEmp = {
      empNo,
      name,
      dept: normalizeDepartmentName(row.dept || 'QUALITY CONTROL'),
      section: canonicalQaSectionName(row.section || 'Warehouse QA'),
      qualification: String(row.qualification || '').trim(),
      doj: String(row.doj || '').trim(),
      expCount: String(row.expCount || ''),
      yearExp: String(row.yearExp || ''),
      currentLevel: ['I', 'L', 'U', 'O'].includes(String(row.currentLevel || '').toUpperCase()) ? String(row.currentLevel).toUpperCase() : 'I',
      targetLevel: ['I', 'L', 'U', 'O'].includes(String(row.targetLevel || '').toUpperCase()) ? String(row.targetLevel).toUpperCase() : 'L',
      email: String(row.email || '').trim(),
      phone: String(row.phone || '').trim(),
    };
    const key = empNo.toLowerCase();
    if (byNo.has(key)) {
      const existingIdx = byNo.get(key);
      employees[existingIdx] = { ...employees[existingIdx], ...cleanEmp };
      updated++;
    } else {
      byNo.set(key, employees.length);
      employees.push(cleanEmp);
      added++;
    }
  });

  await saveAuthoritativeEmployees(employees);
  await logAuditEvent('BULK_IMPORT_EMPLOYEES', req.authUser, `Imported ${added} new, updated ${updated} employees`, req, 'EMPLOYEES');
  return res.json({ success: true, added, updated, errors, total: added + updated });
});

// DELETE /api/employees/:empNo: Admin-only Soft Delete with 30-min Undo Backup
app.delete('/api/employees/:empNo', requireAdminAuth, async (req, res) => {
  const empNoRaw = String(req.params.empNo || '').trim();
  const employees = await getAuthoritativeEmployees();
  const idx = employees.findIndex((e) => String(e.empNo).trim().toLowerCase() === empNoRaw.toLowerCase());
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }
  const removed = employees[idx];
  const backup = await createSoftBackupSnapshot('SOFT_DELETE_EMPLOYEE', req.authUser, `Soft deleted employee ${removed.empNo} (${removed.name})`, { deletedEmployee: removed });
  employees.splice(idx, 1);
  await saveAuthoritativeEmployees(employees);
  customEmployeesMemory = employees;
  await logAuditEvent('SOFT_DELETE_EMPLOYEE', req.authUser, `Soft-deleted employee ${removed.empNo} (Backup ${backup.backupId})`, req, removed.empNo);
  return res.json({
    success: true,
    message: `Employee ${removed.empNo} removed. You can undo within 30 minutes.`,
    backupId: backup.backupId,
    undoExpiresAt: backup.expiresAt
  });
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

  if (user.role === 'emp') {
    const userEmpNo = String(user.empNo).trim();
    const ownOjt = ojtObj[userEmpNo] || null;
    return res.json({
      success: true,
      evaluations: ownOjt ? { [userEmpNo]: ownOjt } : {}
    });
  }

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

  const settings = await getSettingsAuthoritative();
  const ojtPassPct = Number(settings.ojtPassingPct || 70);
  const enrichedOjt = { ...ojtData, ojtPassingPctUsed: ojtPassPct };
  if (typeof enrichedOjt.scorePct === 'number' && !enrichedOjt.qualificationStatus) {
    enrichedOjt.qualificationStatus = enrichedOjt.scorePct >= ojtPassPct ? 'Qualified' : 'Not Yet Qualified';
  }

  await saveAuthoritativeOjtEvaluation(strEmpNo, enrichedOjt);
  await logAuditEvent('OJT_EVALUATION_SAVE', user, `Saved OJT practical evaluation for ${strEmpNo} (${enrichedOjt.scorePct || 0}%)`, req, strEmpNo);

  try {
    const scriptPath = path.join(__dirname, 'update_ojt_excel.py');
    if (fs.existsSync(scriptPath)) {
      execFile('python', [scriptPath, '--emp', strEmpNo], (err, stdout) => {
        if (stdout) console.log('Excel updated for employee:', strEmpNo, stdout.trim());
      });
    }
  } catch (err) {}

  res.json({ success: true, message: `OJT evaluation saved and synced for employee ${strEmpNo}` });
});

// POST /api/ojt-evaluations/reset-all: Superadmin only (Typed confirmation + Soft Backup + Undo)
app.post('/api/ojt-evaluations/reset-all', requireSuperAdminAuth, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'RESET-ALL-OJT') {
    return res.status(400).json({
      success: false,
      message: 'Confirmation phrase mismatch. You must explicitly type "RESET-ALL-OJT" to perform this action.'
    });
  }

  const existingOjt = await getAuthoritativeOjtEvaluations();
  const count = Object.keys(existingOjt || {}).length;
  const backup = await createSoftBackupSnapshot('RESET_ALL_OJT', req.authUser, `Reset all OJT evaluations (${count})`, { ojt: existingOjt });

  const emptyOjt = { __initialized: true };
  if (kvUrl && kvToken) {
    await persistToCloudKvStrict('SET', REDIS_KEYS.ojt, emptyOjt);
  }
  globalOjtEvaluations.clear();
  globalOjtEvaluations._isExplicitlyCleared = true;
  kvCacheTs.ojt = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    try {
      fs.writeFileSync(OJT_JSON_FILE, JSON.stringify(emptyOjt, null, 2), 'utf-8');
    } catch (e) {}
  }

  await logAuditEvent('RESET_ALL_OJT', req.authUser, `Reset all OJT evaluations (${count}) to zero finished (Backup ${backup.backupId})`, req, 'ALL_OJT');
  res.json({
    success: true,
    message: 'All OJT evaluations have been reset to 0 finished successfully! Undo available for 30 minutes.',
    backupId: backup.backupId,
    undoExpiresAt: backup.expiresAt
  });
});

// ---------------------------------------------------------------------
// SETTINGS API (Public Thresholds + Admin Write)
// ---------------------------------------------------------------------
app.get('/api/public-settings', async (req, res) => {
  const s = await getSettingsAuthoritative();
  res.json({
    success: true,
    settings: {
      examPassingPct: Number(s.examPassingPct || 50),
      ojtPassingPct: Number(s.ojtPassingPct || 70),
      examDurationMinutes: Number(s.examDurationMinutes || 45),
      maxTabSwitches: Number(s.maxTabSwitches || 3),
      tabSwitchAction: s.tabSwitchAction || 'terminate'
    }
  });
});

app.get('/api/settings', requireAdminAuth, async (req, res) => {
  const s = await getSettingsAuthoritative();
  res.json({ success: true, settings: s });
});

app.post('/api/settings', requireAdminAuth, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ success: false, message: 'settings object required' });
  }
  const clean = {
    ...(settings.adminEmail !== undefined ? { adminEmail: String(settings.adminEmail).trim() } : {}),
    ...(settings.examPassingPct !== undefined ? { examPassingPct: Math.min(100, Math.max(10, Number(settings.examPassingPct) || 50)) } : {}),
    ...(settings.ojtPassingPct !== undefined ? { ojtPassingPct: Math.min(100, Math.max(10, Number(settings.ojtPassingPct) || 70)) } : {}),
    ...(settings.examDurationMinutes !== undefined ? { examDurationMinutes: Math.min(180, Math.max(5, Number(settings.examDurationMinutes) || 45)) } : {}),
    ...(settings.maxTabSwitches !== undefined ? { maxTabSwitches: Math.min(20, Math.max(1, Number(settings.maxTabSwitches) || 3)) } : {}),
    ...(settings.tabSwitchAction !== undefined ? { tabSwitchAction: ['warn', 'terminate'].includes(settings.tabSwitchAction) ? settings.tabSwitchAction : 'terminate' } : {})
  };
  const saved = await saveSettingsAuthoritative(clean);
  await logAuditEvent('UPDATE_SETTINGS', req.authUser, `Updated settings: Exam Pass=${saved.examPassingPct}%, OJT Pass=${saved.ojtPassingPct}%`, req, 'SETTINGS');
  res.json({ success: true, message: 'Settings saved to Redis & synced', settings: saved });
});

// ---------------------------------------------------------------------
// P2/P3 APIs: SCHEDULES, QUESTION ANALYTICS, CERTIFICATES w/ QR, REMINDERS
// ---------------------------------------------------------------------
app.get('/api/schedules', requireAnyAuth, async (req, res) => {
  if (kvUrl && kvToken) {
    try {
      const cloudSchedules = await syncWithCloudKv('GET', 'yokohama_exam_schedules');
      if (Array.isArray(cloudSchedules)) {
        schedulesMemory.clear();
        cloudSchedules.forEach((s) => { if (s && s.scheduleId) schedulesMemory.set(s.scheduleId, s); });
        return res.json({ success: true, schedules: cloudSchedules.slice().reverse() });
      }
    } catch (e) {}
  }
  return res.json({ success: true, schedules: Array.from(schedulesMemory.values()).reverse() });
});

app.post('/api/schedules', requireSectionAuth, async (req, res) => {
  const { title, dept, section, targetLevel, scheduledDate, durationMinutes, assignedEmpNos, status } = req.body || {};
  if (!title || !scheduledDate) {
    return res.status(400).json({ success: false, message: 'title and scheduledDate are required' });
  }
  const schedule = {
    scheduleId: `SCH-${Date.now().toString(36).toUpperCase()}`,
    title: String(title).trim(),
    dept: dept ? normalizeDepartmentName(dept) : 'ALL',
    section: section ? canonicalQaSectionName(section) : 'ALL',
    targetLevel: String(targetLevel || 'AUTO').toUpperCase(),
    scheduledDate: String(scheduledDate).trim(),
    durationMinutes: Math.min(180, Math.max(10, Number(durationMinutes || 45))),
    assignedEmpNos: Array.isArray(assignedEmpNos) ? assignedEmpNos.map(String) : [],
    createdBy: req.authUser.email || req.authUser.name || 'Manager',
    status: String(status || 'Scheduled'),
    createdAt: new Date().toISOString()
  };
  schedulesMemory.set(schedule.scheduleId, schedule);
  if (kvUrl && kvToken) {
    try {
      const allSchedules = Array.from(schedulesMemory.values());
      await syncWithCloudKv('SET', 'yokohama_exam_schedules', allSchedules);
    } catch (e) {}
  }
  await logAuditEvent('CREATE_EXAM_SCHEDULE', req.authUser, `Scheduled "${schedule.title}" on ${schedule.scheduledDate} (${schedule.section})`, req, schedule.scheduleId);
  return res.json({ success: true, schedule });
});

app.get('/api/analytics/questions', requireSectionAuth, async (req, res) => {
  const records = await getAuthoritativeRecords();
  const statsMap = new Map();
  Object.values(records || {}).forEach((rec) => {
    if (!rec || !Array.isArray(rec.submittedQuestions)) return;
    rec.submittedQuestions.forEach((sq) => {
      if (!sq || !sq.id) return;
      const cur = statsMap.get(sq.id) || {
        id: sq.id,
        question: sq.question || sq.id,
        category: sq.category || 'Quality',
        section: rec.section || '',
        level: rec.targetLevel || 'L',
        attempts: 0,
        wrongCount: 0,
        correctCount: 0
      };
      cur.attempts += 1;
      if (sq.isCorrect) cur.correctCount += 1;
      else cur.wrongCount += 1;
      statsMap.set(sq.id, cur);
    });
  });

  const ranked = Array.from(statsMap.values())
    .map((s) => ({ ...s, failRatePct: s.attempts > 0 ? Math.round((s.wrongCount / s.attempts) * 100) : 0 }))
    .sort((a, b) => b.failRatePct - a.failRatePct || b.wrongCount - a.wrongCount);

  return res.json({ success: true, stats: ranked.slice(0, 50) });
});

app.get('/api/verify-certificate/:empNo', async (req, res) => {
  const empNo = String(req.params.empNo || '').trim();
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find((e) => String(e.empNo).trim().toLowerCase() === empNo.toLowerCase());
  if (!emp) return res.status(404).json({ success: false, verified: false, message: 'Certificate record not found' });

  const records = await getAuthoritativeRecords();
  const rec = records[emp.empNo] || null;
  const ojtAll = await getAuthoritativeOjtEvaluations();
  const ojt = ojtAll[emp.empNo] || null;

  return res.json({
    success: true,
    verified: Boolean(rec && rec.isPassed) || ['L', 'U', 'O'].includes(emp.currentLevel),
    empNo: emp.empNo,
    name: emp.name,
    section: emp.section,
    dept: emp.dept,
    currentLevel: emp.currentLevel,
    examScorePct: rec ? rec.markPct : null,
    examDate: rec ? rec.attemptDate : null,
    ojtStatus: ojt ? ojt.qualificationStatus : null
  });
});

app.get('/api/certificate/:empNo', requireAnyAuth, async (req, res) => {
  const empNo = String(req.params.empNo || '').trim();
  const allowed = await canAccessEmployeeData(req.authUser, empNo);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  const employees = await getAuthoritativeEmployees();
  const emp = employees.find((e) => String(e.empNo).trim().toLowerCase() === empNo.toLowerCase());
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const records = await getAuthoritativeRecords();
  const rec = records[emp.empNo] || null;
  const ojtAll = await getAuthoritativeOjtEvaluations();
  const ojt = ojtAll[emp.empNo] || null;

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const verifyUrl = `${proto}://${host}/api/verify-certificate/${encodeURIComponent(emp.empNo)}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 140, margin: 1 });
  await logAuditEvent('GENERATE_CERTIFICATE', req.authUser, `Generated ILUO QR Certificate for ${emp.empNo}`, req, emp.empNo);

  return res.json({
    success: true,
    certificate: {
      certificateNo: `ATC-ILUO-${emp.empNo}-${emp.currentLevel || 'I'}`,
      empNo: emp.empNo,
      name: emp.name,
      dept: emp.dept,
      section: emp.section,
      doj: emp.doj,
      qualifiedLevel: emp.currentLevel || 'I',
      levelTitle: (ILUO_LEVELS[emp.currentLevel] && ILUO_LEVELS[emp.currentLevel].title) || 'Certified',
      examPct: rec ? rec.markPct : null,
      ojtPct: ojt ? ojt.scorePct : null,
      attemptDate: (rec && rec.attemptDate) || new Date().toLocaleDateString('en-GB'),
      verifyUrl,
      qrDataUrl
    }
  });
});

app.post('/api/reminders/send', requireSectionAuth, async (req, res) => {
  const { empNos, channel } = req.body || {};
  const employees = await getAuthoritativeEmployees();
  const targets = Array.isArray(empNos) && empNos.length > 0
    ? employees.filter((e) => empNos.includes(String(e.empNo)))
    : employees.filter((e) => calculateDojEligibility(e.doj, e.currentLevel).isDueForUpgrade).slice(0, 25);

  let emailsSent = 0;
  const whatsappLinks = [];
  for (const emp of targets) {
    const elig = calculateDojEligibility(emp.doj, emp.currentLevel);
    const msg = `Hello ${emp.name} (${emp.empNo}), based on your Date of Joining (${emp.doj}), you are now eligible for ILUO Level ${elig.eligibleLevel} assessment in ${emp.section}. Please complete your assessment on the Employee Portal.`;
    if ((channel === 'email' || channel === 'both') && emp.email && transporter && user && pass) {
      await transporter.sendMail({
        from: `"ATC Tires Training" <${user}>`,
        to: emp.email,
        subject: `ILUO Level ${elig.eligibleLevel} Assessment Eligibility Reminder`,
        text: msg
      }).then(() => { emailsSent++; }).catch(() => {});
    }
    const cleanPhone = String(emp.phone || '').replace(/\D/g, '');
    whatsappLinks.push({
      empNo: emp.empNo,
      name: emp.name,
      eligibleLevel: elig.eligibleLevel,
      whatsappUrl: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`
    });
  }

  await logAuditEvent('SEND_ELIGIBILITY_REMINDERS', req.authUser, `Prepared ${targets.length} reminders (${emailsSent} emails sent)`, req, 'REMINDERS');
  return res.json({
    success: true,
    totalTargets: targets.length,
    emailsSent,
    whatsappLinks
  });
});

// ---------------------------------------------------------------------
// INDIVIDUAL EMPLOYEE DOCX & PDF GENERATION (Strict 404 & Read-Only)
// ---------------------------------------------------------------------

const ALLOWED_TEMPLATE_FILENAMES = new Set([
  'L Level - Final Finish QA.docx',
  'L Level - Final Finish RRO & ALT QA.docx',
  'L Level - Tire Building QA.docx',
  'L Level - Tire Curing QA.docx',
  'L Level - Solid Tire QA.docx',
  'L Level - Preparatory QA.docx',
  'L Level - Warehouse QA.docx',
  'L Level - FID Inspector QA.docx',

  'U Level - Final Finish QA.docx',
  'U Level - Final Finish RRo & ALT QA.docx',
  'U Level - Final Finish RRO & ALT QA.docx',
  'U Level - Tire Building QA.docx',
  'U Level - Tire Curing QA.docx',
  'U Level - Solid Tire QA.docx',
  'U Level - Preparatory QA.docx',
  'U Level - Warehouse QA.docx',
  'U Level - FID Inspector QA.docx',

  'O Level - Final Finish QA.docx',
  'O Level - Final Finish RRO & ALT QA.docx',
  'O Level - Tire Building QA.docx',
  'O Level - Tire Curing QA.docx',
  'O Level - Solid Tire QA.docx',
  'O Level - Preparatory QA.docx',
  'O Level - Warehouse QA.docx',
  'O Level - FID Inspector QA.docx'
]);

const { getTemplateFilename, mapExactTemplate, generateStandaloneOjtDocx } = require('./docx_generator.js');
let _jsZipLib = null;
let _jsZipLoaded = false;
function getJSZipLib() {
  if (_jsZipLoaded) return _jsZipLib;
  _jsZipLoaded = true;
  try {
    _jsZipLib = require('./jszip.min.js');
  } catch (e) {
    try { _jsZipLib = require('jszip'); } catch (err) {}
  }
  return _jsZipLib;
}

let _serverOjtTemplates = null;
let _serverOjtTemplatesLoaded = false;
function getServerOjtTemplates() {
  if (_serverOjtTemplatesLoaded) return _serverOjtTemplates;
  _serverOjtTemplatesLoaded = true;
  try {
    const ojtCode = fs.readFileSync(path.join(__dirname, 'ojt_templates_data.js'), 'utf-8');
    const vm = require('vm');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(ojtCode, sandbox);
    _serverOjtTemplates = sandbox.OJT_OFFICIAL_TEMPLATES || null;
  } catch (e) {}
  return _serverOjtTemplates;
}

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
  const rawTemplate = getTemplateFilename(targetLevel, emp.section);

  // Strict boundary validation: reject invalid formats, extensions, and traversal sequences
  if (!rawTemplate || typeof rawTemplate !== 'string' || !rawTemplate.toLowerCase().endsWith('.docx')) {
    const err = new Error(`Invalid template format requested: ${rawTemplate}`);
    err.statusCode = 400;
    throw err;
  }

  if (rawTemplate.includes('..') || rawTemplate.includes('/') || rawTemplate.includes('\\') || path.isAbsolute(rawTemplate)) {
    const err = new Error('Access denied: Path traversal detected in template filename');
    err.statusCode = 403;
    throw err;
  }

  const templateFilename = path.basename(String(rawTemplate)).replace(/[^a-zA-Z0-9_\-\.\(\)\s]/g, '');

  if (!ALLOWED_TEMPLATE_FILENAMES.has(templateFilename)) {
    const err = new Error(`Template not in approved allowlist: ${rawTemplate}`);
    err.statusCode = 403;
    throw err;
  }

  const allowedTemplateDirs = [
    path.resolve(__dirname, 'QC_templates'),
    path.resolve('D:', 'QC question'),
    path.resolve(__dirname, 'QC question')
  ];

  let templatePath = null;
  for (const baseDir of allowedTemplateDirs) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const canonicalBase = fs.realpathSync(baseDir);
      const candidate = path.resolve(canonicalBase, templateFilename);
      if (candidate.startsWith(canonicalBase + path.sep) && fs.existsSync(candidate)) {
        const canonicalCandidate = fs.realpathSync(candidate);
        if (canonicalCandidate.startsWith(canonicalBase + path.sep)) {
          templatePath = canonicalCandidate;
          break;
        }
      }
    } catch (e) {}
  }

  if (!templatePath) {
    const err = new Error(`Template not found for ${targetLevel} ${emp.section}: ${rawTemplate}`);
    err.statusCode = 404;
    throw err;
  }

  const templateBuf = fs.readFileSync(templatePath);

  const qBank = await getAuthoritativeQuestions();
  const qbQuestions = qBank[targetLevel] || [];

  const ojtEvaluations = await getAuthoritativeOjtEvaluations();
  const ojtRec = ojtEvaluations[strEmpNo] || null;

  const ojtTemplates = getServerOjtTemplates();
  let ojtTmpl = null;
  if (ojtTemplates && emp && emp.section) {
    const s = emp.section.toLowerCase();
    if (s.includes('solid')) ojtTmpl = ojtTemplates['86D'];
    else if (s.includes('rro') || s.includes('alt')) ojtTmpl = ojtTemplates['83D'];
    else if (s.includes('preparatory')) ojtTmpl = ojtTemplates['85D'];
    else if (s.includes('building') || s.includes('tbm')) ojtTmpl = ojtTemplates['87D'];
    else if (s.includes('curing')) ojtTmpl = ojtTemplates['88D'];
    else if (s.includes('warehouse') || s.includes('data entry')) ojtTmpl = ojtTemplates['89D'];
    else if (s.includes('fid')) ojtTmpl = ojtTemplates['90D'];
    else if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) ojtTmpl = ojtTemplates['90G'];
    else ojtTmpl = ojtTemplates['84D'];
  }

  const zip = await mapExactTemplate(templateBuf, emp, examRecord, getJSZipLib(), qbQuestions, ojtRec, ojtTmpl);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

async function convertDocxBufferToPdf(docxBuf, identifier = 'doc') {
  const safeTempRoot = path.resolve(os.tmpdir(), 'yokohama_pdf_jobs');
  if (!fs.existsSync(safeTempRoot)) {
    fs.mkdirSync(safeTempRoot, { recursive: true, mode: 0o700 });
  }

  // Create isolated private job directory with 0o700 permissions
  const jobDir = fs.mkdtempSync(path.join(safeTempRoot, 'job-'));
  try {
    fs.chmodSync(jobDir, 0o700);
  } catch (e) {}

  const safePrefix = String(identifier).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'doc';
  const uniqueId = crypto.randomUUID();
  const tempDocx = path.resolve(jobDir, `${safePrefix}_${uniqueId}.docx`);
  const tempPdf = path.resolve(jobDir, `${safePrefix}_${uniqueId}.pdf`);

  const canonicalJobDir = fs.realpathSync(jobDir);
  if (!tempDocx.startsWith(canonicalJobDir + path.sep) || !tempPdf.startsWith(canonicalJobDir + path.sep)) {
    throw new Error('Access denied: Invalid temporary file path');
  }

  try {
    // Exclusive file creation with restricted 0o600 permissions
    fs.writeFileSync(tempDocx, docxBuf, { flag: 'wx', mode: 0o600 });

    const psScript = path.join(__dirname, 'word_to_pdf.ps1');
    if (process.platform === 'win32' && fs.existsSync(psScript)) {
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', psScript, '-srcPath', tempDocx, '-dstPath', tempPdf], (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        });
      });

      if (fs.existsSync(tempPdf)) {
        // Prevent symlink attacks: verify tempPdf is a regular file
        const lstat = fs.lstatSync(tempPdf);
        if (lstat.isSymbolicLink() || !lstat.isFile()) {
          throw new Error('Security violation: Converted PDF is a symbolic link or invalid file');
        }
        return fs.readFileSync(tempPdf);
      }
    }

    throw new Error('Native Word-to-PDF conversion requires Windows with Microsoft Word installed.');
  } finally {
    // Guaranteed cleanup in finally block
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error('Temporary directory cleanup error:', cleanupErr.message);
    }
  }
}

const { generateOfficialReportHtml, generateSectionSummaryReportHtml } = require('./report_html_generator.js');

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

  const ojtTemplates = getServerOjtTemplates();
  let ojtTmpl = null;
  if (ojtTemplates && emp && emp.section) {
    const s = emp.section.toLowerCase();
    if (s.includes('solid')) ojtTmpl = ojtTemplates['86D'];
    else if (s.includes('rro') || s.includes('alt')) ojtTmpl = ojtTemplates['83D'];
    else if (s.includes('preparatory')) ojtTmpl = ojtTemplates['85D'];
    else if (s.includes('building') || s.includes('tbm')) ojtTmpl = ojtTemplates['87D'];
    else if (s.includes('curing')) ojtTmpl = ojtTemplates['88D'];
    else if (s.includes('warehouse') || s.includes('data entry')) ojtTmpl = ojtTemplates['89D'];
    else if (s.includes('fid')) ojtTmpl = ojtTemplates['90D'];
    else if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) ojtTmpl = ojtTemplates['90G'];
    else ojtTmpl = ojtTemplates['84D'];
  }

  return generateOfficialReportHtml(emp, examRecord, qbQuestions, ojtRec, ojtTmpl, getLogoBase64());
}

const PDF_JOB_TIMEOUT_MS = 25000;
const BROWSER_IDLE_CLOSE_MS = 30000;
const CHROMIUM_LAUNCH_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--renderer-process-limit=1',
  '--no-zygote'
];

let browserInstance = null;
let browserIdleTimer = null;
let pdfRenderQueue = Promise.resolve();

function scheduleBrowserIdleClose() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    browserIdleTimer = null;
    await closeChromiumBrowser();
  }, BROWSER_IDLE_CLOSE_MS);
  if (typeof browserIdleTimer.unref === 'function') browserIdleTimer.unref();
}

async function closeChromiumBrowser() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  if (browserInstance) {
    const toClose = browserInstance;
    browserInstance = null;
    const proc = typeof toClose.process === 'function' ? toClose.process() : null;
    try {
      await Promise.race([
        toClose.close(),
        new Promise((resolve) => setTimeout(resolve, 2500))
      ]);
    } catch (e) {}
    if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch (e) {}
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
  }
}

async function getChromiumBrowser() {
  const isConnected = browserInstance && (typeof browserInstance.isConnected === 'function'
    ? browserInstance.isConnected()
    : Boolean(browserInstance.connected));
  if (isConnected) {
    scheduleBrowserIdleClose();
    return browserInstance;
  }
  if (browserInstance) {
    await closeChromiumBrowser();
  }
  const puppeteer = require('puppeteer-core');
  const preferredExecPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  if (preferredExecPath && fs.existsSync(preferredExecPath)) {
    browserInstance = await puppeteer.launch({
      executablePath: preferredExecPath,
      headless: true,
      args: CHROMIUM_LAUNCH_FLAGS,
      ignoreHTTPSErrors: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });
  } else if (process.env.VERCEL || process.platform === 'linux') {
    const chromiumPkg = require('@sparticuz/chromium');
    const chromium = chromiumPkg.default || chromiumPkg;
    const launchArgs = Array.from(new Set([
      ...(Array.isArray(chromium.args) ? chromium.args : []),
      ...CHROMIUM_LAUNCH_FLAGS
    ]));
    browserInstance = await puppeteer.launch({
      args: launchArgs,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });
  } else {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    const execPath = possiblePaths.find(p => fs.existsSync(p));
    browserInstance = await puppeteer.launch({
      executablePath: execPath,
      headless: true,
      args: CHROMIUM_LAUNCH_FLAGS,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });
  }
  scheduleBrowserIdleClose();
  return browserInstance;
}

// Single-concurrency PDF queue prevents parallel Chromium tabs from exhausting 1 vCPU (1000m) / 1Gi RAM
function renderHtmlToPdf(html) {
  const run = async () => {
    let page = null;
    let timeoutId = null;
    let timedOut = false;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`PDF render timed out after ${PDF_JOB_TIMEOUT_MS}ms`));
      }, PDF_JOB_TIMEOUT_MS);
      if (typeof timeoutId.unref === 'function') timeoutId.unref();
    });

    const jobPromise = (async () => {
      const browser = await getChromiumBrowser();
      page = await browser.newPage();
      page.setDefaultTimeout(PDF_JOB_TIMEOUT_MS);
      await page.setContent(html, { waitUntil: 'load', timeout: PDF_JOB_TIMEOUT_MS });
      const pdfBuf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
        timeout: PDF_JOB_TIMEOUT_MS
      });
      return Buffer.from(pdfBuf);
    })();

    try {
      return await Promise.race([jobPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (page) {
        try { await page.close(); } catch (e) {}
      }
      if (timedOut) {
        jobPromise.catch(() => {});
        await closeChromiumBrowser();
      } else {
        scheduleBrowserIdleClose();
      }
    }
  };
  const next = pdfRenderQueue.then(run, run);
  pdfRenderQueue = next.catch(() => {});
  return next;
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
    await logAuditEvent('EXPORT_EMPLOYEE_DOCX', user, `Exported Assessment DOCX for ${empNo}`, req, empNo);
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

    const ojtTemplates = getServerOjtTemplates();
    let ojtTmpl = null;
    if (ojtTemplates && emp && emp.section) {
      const s = emp.section.toLowerCase();
      if (s.includes('solid')) ojtTmpl = ojtTemplates['86D'];
      else if (s.includes('rro') || s.includes('alt')) ojtTmpl = ojtTemplates['83D'];
      else if (s.includes('preparatory')) ojtTmpl = ojtTemplates['85D'];
      else if (s.includes('building') || s.includes('tbm')) ojtTmpl = ojtTemplates['87D'];
      else if (s.includes('curing')) ojtTmpl = ojtTemplates['88D'];
      else if (s.includes('warehouse') || s.includes('data entry')) ojtTmpl = ojtTemplates['89D'];
      else if (s.includes('fid')) ojtTmpl = ojtTemplates['90D'];
      else if (s.includes('buffer') || s.includes('compound') || s.includes('replate')) ojtTmpl = ojtTemplates['90G'];
      else ojtTmpl = ojtTemplates['84D'];
    }
    if (!ojtTmpl && ojtTemplates) ojtTmpl = ojtTemplates['87D'] || Object.values(ojtTemplates)[0];

    const zip = await generateStandaloneOjtDocx(emp, ojtTmpl, (ojtRec && ojtRec.scores) || {}, (ojtRec && ojtRec.wiChecks) || {}, ojtRec || {}, getJSZipLib());
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await logAuditEvent('EXPORT_OJT_DOCX', user, `Exported OJT DOCX for ${empNo}`, req, empNo);
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
    await logAuditEvent('EXPORT_EMPLOYEE_DOCX', user, `Generated Assessment DOCX for ${strEmpNo}`, req, strEmpNo);
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
    await logAuditEvent('EXPORT_EMPLOYEE_PDF', user, `Exported Assessment PDF for ${empNo}`, req, empNo);
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
    await logAuditEvent('EXPORT_EMPLOYEE_PDF', user, `Generated Assessment PDF for ${strEmpNo}`, req, strEmpNo);
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
    return res.status(status).send(`<h3>Error: ${escapeHtml(err.message)}</h3>`);
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
  const activeEmployees = employees.filter(e => !e.isLeft && e.status !== 'LEFT');
  const leftEmployees = employees.length - activeEmployees.length;
  res.json({
    success: true,
    data: {
      totalEmployees: activeEmployees.length,
      leftEmployees,
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
  if (err && err.exposeMessage) {
    return res.status(status).json({
      success: false,
      code: err.code || 'STORAGE_ERROR',
      message: err.message
    });
  }
  return res.status(status).json({
    success: false,
    message: 'An internal error occurred while processing your request. Please contact administrator.'
  });
});

// Fallback route for Client-Side SPA Routing (Both portals)
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|json|map|docx|xlsx|pdf|txt|woff2?|ttf|eot)$/i)) {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }
  if (isEmployeePortalRequest(req)) {
    return res.sendFile(path.join(STATIC_DIR, 'employee.html'));
  }
  return res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

if (require.main === module) {
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Yokohama Admin Portal running at http://0.0.0.0:${PORT}`);
    if (kvUrl && kvToken) {
      setImmediate(() => {
        scheduleUpstashStartupMigration(0);
      });
    }
  });
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearUpstashSeedRetryTimer();
    const forceExit = setTimeout(() => process.exit(0), 5000);
    if (typeof forceExit.unref === 'function') forceExit.unref();
    try { await closeChromiumBrowser(); } catch (e) {}
    httpServer.close(() => process.exit(0));
    if (typeof httpServer.closeIdleConnections === 'function') {
      httpServer.closeIdleConnections();
    }
  };
  process.once('SIGTERM', gracefulShutdown);
  process.once('SIGINT', gracefulShutdown);
}

app.buildDocxBufferForEmployee = buildDocxBufferForEmployee;
app.convertDocxBufferToPdf = convertDocxBufferToPdf;
app.buildHtmlReportForEmployee = buildHtmlReportForEmployee;
app.renderDynamicPdf = renderDynamicPdf;
app.getAuthoritativeEmployees = getAuthoritativeEmployees;
app.saveAuthoritativeEmployees = saveAuthoritativeEmployees;
app.getAuthoritativeRecords = getAuthoritativeRecords;
app.saveAllAuthoritativeRecords = saveAllAuthoritativeRecords;
app.getAuthoritativeQuestions = getAuthoritativeQuestions;
app.getAuthoritativeOjtEvaluations = getAuthoritativeOjtEvaluations;
app.saveAllAuthoritativeOjtEvaluations = saveAllAuthoritativeOjtEvaluations;
app.ensureUpstashInitialSeed = ensureUpstashInitialSeed;
app.isRateKeyLocked = isRateKeyLocked;
app.recordRateFailureOnKey = recordRateFailureOnKey;
app.clearRateAccountSuccess = clearRateAccountSuccess;
app.resetRateLimitMemory = () => {
  memoryRateCounters.clear();
  memoryRateLockouts.clear();
  isKvWriteForbidden = false;
};
app.setKvWriteForbidden = (val) => {
  isKvWriteForbidden = val;
};
app.getKvWriteForbidden = () => isKvWriteForbidden;
app.LUA_ATOMIC_RATE_LIMIT = LUA_ATOMIC_RATE_LIMIT;

app.buildSectionSummaryReportData = buildSectionSummaryReportData;

module.exports = app;

