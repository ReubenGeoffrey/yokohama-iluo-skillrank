# Split Yokohama ILUO into Two Connected Websites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the existing Yokohama ILUO Skill Assessment Portal into two independent websites (Management Portal & Employee Portal) connected to the same backend and authoritative database.

**Architecture:** A unified Express/Node backend (`server.js`) serving two decoupled frontend applications (`index.html` for Management Portal and `employee.html` for Employee Portal) using domain/host and path routing, sharing identical authoritative JSON/Redis data stores and RBAC security APIs. Both websites are configured for independent Vercel deployments.

**Tech Stack:** Node.js, Express 5, Vanilla JavaScript (ES6+), HTML5/CSS3, Upstash Redis/JSON storage, Node Test Runner (`node:test`).

**Spec:** Antigravity Master Prompt — Split Yokohama ILUO into Two Connected Websites.

## Global Constraints

- Never hardcode credentials, secrets, or correct answers in any client-delivered file (HTML, CSS, JS) — GATE 2 & GATE 3 compliance.
- Preserve existing primary keys, employee data (236 candidates), question banks, and assessment records.
- Preserve all existing management views and role authentication flows (Admin/HR, Dept HOD, Section Supervisor, Skill Evaluator).
- Enforce strict server-side RBAC and employee data isolation (IDOR protection).
- Maintain 100% pass rate across existing 33 gate/security/auth test suites.

## Review Focus

1. Employee accessing `/api/admin/*` or `/api/records/reset*` endpoints directly -> Expect `401` or `403 Forbidden`.
2. Employee A requesting Employee B's profile, assessment answers, or reports via URL or query -> Expect `403 Forbidden` / strictly filtered own record.
3. Host header routing (`employee.yourdomain.in` vs `management.yourdomain.in` or `APP_TARGET=employee`) -> Expect appropriate portal HTML served.
4. Duplicate assessment submission or answer tampering by employee -> Expect server-side rejection (`409 Conflict`).
5. Session expiry / logged-out replay -> Expect `401 Unauthorized`.

---

### Task 1: Backend Multi-Site Routing and CORS Enhancement

**Files:**
- Modify: `server.js:30-60` (CORS allowlist & environment variables)
- Modify: `server.js:140-190` (Static file serving for employee portal)
- Modify: `server.js:2850-2870` (Host/Path-based routing to serve `employee.html` vs `index.html`)
- Test: `tests/two_portals.test.js`

**Interfaces:**
- Consumes: `req.headers.host`, `process.env.APP_TARGET`, `process.env.ALLOWED_ORIGINS`
- Produces: Serves `employee.html` for employee hosts/paths, `index.html` for management hosts/paths, returns CORS headers for both origins.

- [ ] **Step 1: Write tests for multi-site host routing and CORS**
- [ ] **Step 2: Run test to verify it fails prior to implementation**
- [ ] **Step 3: Update `server.js` with host detection, `APP_TARGET` check, `/employee` path routing, and multi-origin CORS support**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit changes**

---

### Task 2: Management Portal Refinement (`index.html`)

**Files:**
- Modify: `index.html:35-115` (Role Navigation and Portal Cards)
- Modify: `index.html:116-148` (Redirect/helper for employees visiting management portal)

**Interfaces:**
- Consumes: `switchRolePortal(role)`
- Produces: Clean enterprise management landing strictly showing Department, HR Login, Section Login, and Skill Assessment Login.

- [ ] **Step 1: Remove Employee Portal card from Management Portal landing page and nav bar**
- [ ] **Step 2: Add sleek notice banner/link for employees directing them to the Employee Portal**
- [ ] **Step 3: Verify Management views remain 100% functional (Admin, Dept, Section, Evaluator)**
- [ ] **Step 4: Run test suite (`npm test`) to ensure no regression**
- [ ] **Step 5: Commit changes**

---

### Task 3: Build Dedicated Employee Portal (`employee.html` & `employee.js`)

**Files:**
- Create: `employee.html` (Standalone Employee Portal SPA)
- Create: `employee.js` (Lightweight Employee controller & API client)
- Modify: `styles.css` (Employee-specific styling enhancements)

**Interfaces:**
- Consumes: `/api/auth/employee/login`, `/api/auth/employee/me`, `/api/auth/employee/logout`, `/api/exam/start`, `/api/exam/submit`, `/api/records`
- Produces: Complete employee user experience: Login with password toggle, Dashboard with ILUO badge, Assigned Exam card, Active Quiz screen, Results view, Profile card.

- [ ] **Step 1: Create `employee.html` with clean responsive layout and no management elements**
- [ ] **Step 2: Implement `employee.js` with session management, exam runner, auto-save, and timer**
- [ ] **Step 3: Add password visibility toggle, responsive design, and accessible inputs**
- [ ] **Step 4: Verify in browser and check with `node --check`**
- [ ] **Step 5: Commit changes**

---

### Task 4: Comprehensive Two-Portal Test Suite

**Files:**
- Create: `tests/two_portals.test.js`

**Interfaces:**
- Consumes: `server.js` via `node:test`
- Produces: 10 automated test scenarios covering HR access, HOD isolation, Section isolation, Evaluator scoping, Employee auth & IDOR protection, Exam submission persistence, and Error recovery.

- [ ] **Step 1: Write `tests/two_portals.test.js` covering all 10 Phase 6 requirements**
- [ ] **Step 2: Run `node --test tests/two_portals.test.js`**
- [ ] **Step 3: Fix any uncovered boundary conditions**
- [ ] **Step 4: Run full test suite `npm test` (all 34+ test files)**
- [ ] **Step 5: Commit changes**

---

### Task 5: Vercel Configuration & Deployment Documentation

**Files:**
- Modify: `vercel.json` (Include `employee.html` and `employee.js` in build bundle)
- Create: `DEPLOYMENT.md` (Step-by-step instructions for 2 Vercel projects, custom domains, environment variables, and rollback plan)
- Modify: `README.md` (Updated system architecture and dual portal guide)

- [ ] **Step 1: Update `vercel.json` with multi-app files and route rewrites**
- [ ] **Step 2: Create comprehensive `DEPLOYMENT.md` with Vercel deployment instructions**
- [ ] **Step 3: Update `README.md` with architecture diagram and run instructions**
- [ ] **Step 4: Run final verification checks**
- [ ] **Step 5: Commit and push changes**
