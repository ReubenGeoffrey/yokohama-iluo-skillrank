# Unified Single Website & Cloud Run Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the entire Yokohama ILUO portal (management portal, employee assessment portal, backend APIs, Upstash Redis persistence, and Chromium PDF generator) into a single production website served by one Node.js server from one URL on Google Cloud Run.

**Architecture:**
A single authoritative Express backend (`server.js`) serves compiled static production assets from a `dist/` directory on `/` and mounts all backend endpoints under `/api/*`. Client routes (management dashboard, section portal, evaluator portal, department HOD view, and employee assessment portal at `/employee`) resolve cleanly on the same origin via an SPA fallback route. The application binds to `0.0.0.0` with port defaulting to `process.env.PORT || 3000` (and `8080` in Cloud Run). All PDF generation uses an internal single-concurrency queue (`pdfRenderQueue`) powered by headless Chromium. Upstash Redis serves as persistent cloud storage with local JSON fallback, and deployment is standardized into a single-stage container matching Cloud Run's 1 vCPU (`1000m`) and 1–2 GiB memory limits.

**Tech Stack:**
- Node.js 20+ / Express 5
- Vanilla JavaScript, CSS, HTML5 SPA
- Upstash Redis REST API
- Puppeteer-Core & Sparticuz Chromium (single-concurrency queue)
- ExcelJS, JSZip, QRcode, bcryptjs, CSRF
- Docker / Google Cloud Run (Knatis v1 service)

**Spec:** User request: Unify entire project into ONE single website on ONE single URL on Google Cloud Run with single container deployment, zero split domains, static compilation into `dist/`, SPA fallback, relative `/api/*` requests, and 100% test pass rate.

## Global Constraints
- Target platform: Google Cloud Run with limits strictly `1000m` (1 vCPU) and `1Gi`–`2Gi` memory.
- Default port: `process.env.PORT || 3000` (Cloud Run sets `PORT=8080`).
- Server host binding: `0.0.0.0`.
- All frontend network requests MUST use relative paths (`/api/...`).
- Upstash Redis credentials (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) MUST NOT be hardcoded.
- Existing 81 automated tests in `tests/*.test.js` MUST all pass (100% pass rate).
- No split domains or external frontend URLs in CORS allowlists.

## Review Focus
1. Direct page refreshes on non-root paths (e.g. `/employee`, `/management`, `/section`) must return the respective HTML and never 404.
2. Missing static assets (e.g. non-existent `.png` or `.js`) must return a 404 JSON/status and not enter an SPA redirect loop or return HTML.
3. Same-origin `fetch` calls to `/api/*` from browser clients without an explicit `Origin` header (or matching host) must pass CORS and CSRF checks without 403 errors.
4. Concurrency in headless Chromium must not exceed 1 concurrent render (`pdfRenderQueue`) to prevent memory spikes in the 1Gi container.
5. In development mode without a pre-existing `dist/` folder, the server must gracefully fall back to serving root static files so development remains instantaneous.

---

### Task 1: Create Build Pipeline (`build.js`) & Update Root `package.json`

**Files:**
- Create: `build.js`
- Modify: `package.json:6-12`
- Test: `tests/build_pipeline.test.js`

**Interfaces:**
- Consumes: Static frontend assets (`index.html`, `employee.html`, `app.js`, `employee.js`, `styles.css`, `shared_constants.js`, `docx_generator.js`, `report_html_generator.js`, `master_excel_b64.js`, `data.js`, `ojt_templates_data.js`, `seed_data.js`, vendor scripts `*.min.js`, logos, `QC_templates/`, `public/`).
- Produces: Production directory `dist/` containing all static frontend assets ready for `express.static`.

- [ ] **Step 1: Write test for the build pipeline**

```javascript
// tests/build_pipeline.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('BUILD PIPELINE: npm run build outputs complete dist directory with essential frontend assets', () => {
  const distDir = path.join(__dirname, '..', 'dist');
  execSync('node build.js', { stdio: 'pipe' });
  assert.ok(fs.existsSync(distDir), 'dist/ directory must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'dist/index.html must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'employee.html')), 'dist/employee.html must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'app.js')), 'dist/app.js must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'employee.js')), 'dist/employee.js must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'styles.css')), 'dist/styles.css must exist');
  assert.ok(fs.existsSync(path.join(distDir, 'public', 'templates', 'production_template.xlsx')), 'production_template.xlsx must exist in dist');
  assert.ok(fs.existsSync(path.join(distDir, 'public', 'templates', 'qa_template.xlsx')), 'qa_template.xlsx must exist in dist');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/build_pipeline.test.js`
Expected: FAIL (Cannot find module 'build.js')

- [ ] **Step 3: Implement `build.js`**

Create `build.js` that:
1. Performs `node --check` validation on core scripts (`server.js`, `excel_sync_engine.js`, `app.js`, `employee.js`, `shared_constants.js`, `build.js`).
2. Cleans and creates `dist/` directory.
3. Copies all frontend assets into `dist/`:
   - `index.html`, `employee.html`, `app.js`, `employee.js`, `styles.css`
   - `shared_constants.js`, `docx_generator.js`, `report_html_generator.js`, `master_excel_b64.js`, `data.js`, `ojt_templates_data.js`, `seed_data.js`
   - Vendor `.min.js` files: `xlsx.full.min.js`, `jszip.min.js`, `docx-preview.min.js`, `mammoth.browser.min.js`, `html2pdf.bundle.min.js`
   - Media: `atg_logo.png`, `yokohama_logo.png`, `favicon.ico`, `manifest.json`
   - Recursive copy of `QC_templates/` and `public/` (ensuring `public/templates/*.xlsx` are preserved).
4. Prints a summary of files copied and build time.

- [ ] **Step 4: Update `package.json` scripts**

Update `package.json` scripts:
```json
"scripts": {
  "build": "node build.js",
  "start": "node server.js",
  "dev": "PORT=3000 node server.js",
  "lint": "node --check server.js && node --check excel_sync_engine.js && node --check app.js && node --check employee.js && node --check shared_constants.js && node --check build.js",
  "test": "node --test --test-concurrency=1 tests/*.test.js"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/build_pipeline.test.js`
Expected: PASS

---

### Task 2: Update `server.js` for Static Asset Serving, Unified SPA Fallback & Port Binding

**Files:**
- Modify: `server.js:54-58, 640-735, 5825-5845`
- Test: `tests/spa_routing.test.js`

**Interfaces:**
- Consumes: Built `dist/` folder or root fallback directory.
- Produces: Unified HTTP server listening on `0.0.0.0:${PORT}` (`PORT || 3000`), serving static assets on `/`, mounting `/api/*`, and serving SPA fallback for deep links.

- [ ] **Step 1: Write test for SPA fallback and static serving from single URL**

```javascript
// tests/spa_routing.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const app = require('../server.js');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('SPA ROUTING: Root / serves index.html on single unified domain', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ILUO Skill Assessment Portal') || text.includes('navbarSystemTitle'));
});

test('SPA ROUTING: Direct path /employee serves employee.html on same domain', async () => {
  const res = await fetch(`${baseUrl}/employee`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Employee Skill Assessment Portal') || text.includes('employee.js'));
});

test('SPA ROUTING: Deep management client route falls back to index.html without 404', async () => {
  const res = await fetch(`${baseUrl}/secure-control/dashboard`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ILUO Skill Assessment Portal') || text.includes('navbarSystemTitle'));
});

test('SPA ROUTING: Missing static file (.png, .js, .css) returns 404 JSON, not HTML', async () => {
  const res = await fetch(`${baseUrl}/non_existent_image.png`);
  assert.strictEqual(res.status, 404);
  const json = await res.json();
  assert.strictEqual(json.success, false);
});
```

- [ ] **Step 2: Run test to check existing behavior**

Run: `node --test tests/spa_routing.test.js`
Expected: May fail on deep route fallback or static file 404 handling.

- [ ] **Step 3: Modify `server.js`**

1. Set `PORT`:
   ```javascript
   const PORT = Number(process.env.PORT) || 3000;
   ```
2. Determine `STATIC_DIR`:
   ```javascript
   const STATIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
     ? path.join(__dirname, 'dist')
     : __dirname;
   ```
3. Configure `express.static`:
   ```javascript
   app.use(express.static(STATIC_DIR, {
     maxAge: isProduction ? '1h' : '0',
     index: false
   }));
   ```
4. Define portal routes:
   - `GET /` and `GET /management` -> serve `path.join(STATIC_DIR, 'index.html')` (or `employee.html` if host includes employee).
   - `GET /employee` and `GET /employee.html` -> serve `path.join(STATIC_DIR, 'employee.html')`.
5. Update SPA fallback middleware:
   ```javascript
   app.use((req, res) => {
     if (req.path.startsWith('/api/') || req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|json|map|docx|xlsx|pdf|txt|woff2?|ttf|eot)$/i)) {
       return res.status(404).json({ success: false, error: 'Not Found' });
     }
     if (isEmployeePortalRequest(req)) {
       return res.sendFile(path.join(STATIC_DIR, 'employee.html'));
     }
     return res.sendFile(path.join(STATIC_DIR, 'index.html'));
   });
   ```
6. Ensure server listen binds to `0.0.0.0`:
   ```javascript
   const httpServer = app.listen(PORT, '0.0.0.0', () => {
     console.log(`🚀 Yokohama Portal running at http://0.0.0.0:${PORT}`);
   });
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/spa_routing.test.js`
Expected: PASS

---

### Task 3: Unify CORS, Origin Resolution & Remove Split-Domain Hardcoding

**Files:**
- Modify: `server.js:415-465`
- Modify: `index.html:15-23`
- Test: `tests/cors_unification.test.js`

**Interfaces:**
- Consumes: Inbound HTTP requests with or without `Origin` and `Host` headers.
- Produces: Seamless approval for same-origin requests, Cloud Run (`*.run.app`), and local requests without cross-origin rejections.

- [ ] **Step 1: Write test for unified same-origin CORS handling**

```javascript
// tests/cors_unification.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const app = require('../server.js');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('CORS: Same-origin requests without Origin header succeed', async () => {
  const res = await fetch(`${baseUrl}/api/csrf-token`);
  assert.strictEqual(res.status, 200);
});

test('CORS: Same-origin requests matching Host header succeed with CORS headers', async () => {
  const u = new URL(baseUrl);
  const res = await fetch(`${baseUrl}/api/csrf-token`, {
    headers: { 'Origin': u.origin }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), u.origin);
});

test('CORS: Cloud Run domains (*.run.app) are automatically permitted', async () => {
  const cloudRunOrigin = 'https://iluo-skill-portal-xyz-as.a.run.app';
  const res = await fetch(`${baseUrl}/api/csrf-token`, {
    headers: { 'Origin': cloudRunOrigin }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), cloudRunOrigin);
});
```

- [ ] **Step 2: Run test to check current behavior**

Run: `node --test tests/cors_unification.test.js`

- [ ] **Step 3: Clean up `ALLOWED_ORIGINS` in `server.js`**

1. Remove hardcoded split-domain URLs:
   - `https://yokohama-iluo-portal.vercel.app`
   - `https://yokohama-iluo-employee.vercel.app`
   - `https://management.yourdomain.in`
   - `https://employee.yourdomain.in`
2. Update `isOriginAllowed(origin, req)` to automatically allow:
   - Empty origin (`!origin` -> same-origin navigation/direct fetch)
   - Dynamic same-origin match against `req.headers.host` / `x-forwarded-host`
   - Any Cloud Run origin (`*.run.app`)
   - Any configured origins from `ALLOWED_ORIGINS` environment variable
   - Localhost / 127.0.0.1
3. In `index.html`, update the client-side domain router guard so it only redirects to `/employee.html` if host explicitly contains `employee` and path is not already `/employee.html` (preserving backwards compatibility while remaining non-intrusive on unified domain).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cors_unification.test.js`
Expected: PASS

---

### Task 4: Author Single-Container `Dockerfile` & Review Cloud Run Config (`service.yaml`, `.dockerignore`)

**Files:**
- Create: `Dockerfile`
- Modify: `service.yaml`
- Modify: `.dockerignore`
- Test: Syntax and configuration validation

**Interfaces:**
- Consumes: Single repository codebase.
- Produces: Production Docker image configuration matching 1000m (1 vCPU), 1Gi–2Gi memory, port 8080.

- [ ] **Step 1: Write `Dockerfile`**

Create `Dockerfile`:
```dockerfile
# Multi-stage production Dockerfile for Yokohama ILUO Portal on Google Cloud Run
# 1 vCPU (1000m) / 1Gi RAM profile

# --- Builder Stage ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Run unified build to compile static frontend into dist/
RUN node build.js

# --- Runtime Stage ---
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install runtime dependencies required for headless Chromium / Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy built application and production dependencies from builder
COPY --from=builder /app /app

EXPOSE 8080

# Launch server
CMD ["node", "server.js"]
```

- [ ] **Step 2: Review & verify `service.yaml`**

Ensure `service.yaml` contains:
- `cpu: "1000m"`
- `memory: "1Gi"`
- `containerPort: 8080`
- Secrets mapped: `iluo-session-secret`, `iluo-redis-url`, `iluo-redis-token`
- `timeoutSeconds: 120`
- `containerConcurrency: 40`

- [ ] **Step 3: Update `.dockerignore`**

Ensure `.dockerignore` excludes unnecessary files (`.git`, `tests`, `docs`, `*.md`, `*.ps1`, `*.bat`, `*.py`) while ensuring `public/templates` (with `.xlsx` templates) and source assets are included in the build.

---

### Task 5: End-to-End Build, Test Suite, and Local Single-Server URL Verification

**Files:**
- Test all components end-to-end
- Run full test suite: `npm test`

- [ ] **Step 1: Run `npm run build`**

Run: `npm run build`
Expected: `0` build/lint errors, creates `dist/` with all static assets.

- [ ] **Step 2: Run full automated test suite**

Run: `npm test`
Expected: All 81 tests in `tests/*.test.js` pass with 0 failures.

- [ ] **Step 3: Launch single server locally**

Run: `npm start`
Expected: Server starts on port 3000 (or `PORT`).

- [ ] **Step 4: Verify all critical flows on ONE single URL (`http://localhost:3000`)**

Verify via HTTP requests:
1. `GET http://localhost:3000/` -> 200 OK (Management / Main Portal)
2. `GET http://localhost:3000/employee` -> 200 OK (Employee Portal)
3. `GET http://localhost:3000/secure-control` -> 200 OK (SPA fallback to index.html)
4. `GET http://localhost:3000/healthz` -> 200 OK (`{ status: 'ok' }`)
5. `GET http://localhost:3000/api/csrf-token` -> 200 OK (`{ success: true }`)
6. `GET http://localhost:3000/api/health` -> 200 OK (Database persistence status)
7. `POST http://localhost:3000/api/auth/admin/login` -> 200 OK
8. `GET http://localhost:3000/api/export/production-excel` -> 200 OK (Excel generation)
9. PDF export endpoint -> 200 OK (single-concurrency `pdfRenderQueue`)

---
