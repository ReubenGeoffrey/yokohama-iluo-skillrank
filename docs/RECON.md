# Phase 1: Reconnaissance Report (System Architecture & Security Audit)

**Project:** ATC Tires (Yokohama Group) ILUO Skill Assessment & Analytics Portal  
**Deployment Target:** Vercel (`https://yokohama-iluo-portal.vercel.app/` & `https://yokohama-iluo-employee.vercel.app/`)  
**Git Branch:** `audit/full-fix`  
**Date of Audit:** 2026-11-11  
**Audit Standard:** Principal Software Engineer, Application Security Architect, QA Lead

---

## 1. Executive Summary

This reconnaissance report provides an authoritative, source-verified inspection of the ATC Tires ILUO Skill Assessment & Analytics Portal prior to code modifications. The application is an enterprise shop-floor assessment platform serving 1,462 employees across 35 manufacturing sections. It facilitates MCQ testing for technical skill progression across the ILUO matrix (I = Beginner/Induction, L = Learner, U = Executor, O = Expert), practical On-the-Job Training (OJT) evaluations, training-need prioritization, and compliance reporting (Excel/Word format `ATC/T/FOR/HR/87D`).

The current codebase is an Express 5.2.1 monolithic application deployed as a Vercel serverless function, accompanied by client-side single-page application (SPA) scripts (`app.js`, `employee.js`, `data.js`) and Capacitor 8.5.2 Android packaging.

---

## 2. Stack & Architecture

### 2.1 Technology Stack Matrix
| Component | Implementation | Notes / Version |
| :--- | :--- | :--- |
| **Backend Runtime** | Node.js (CommonJS) / Express 5.2.1 | Single serverless entrypoint via `server.js` mapped in `vercel.json` |
| **Serverless Engine** | `@vercel/node` | Monolith bundle with `includeFiles` directive |
| **Mobile Packaging** | `@capacitor/core` & `@capacitor/android` | v8.5.2; wraps client assets for Android APK build |
| **Database / Persistence** | Upstash Redis REST KV + Local JSON fallback | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |
| **Authentication** | Custom Session Cookies + Upstash Redis Tokens | Signed cookies via `cookie-parser` + `SESSION_SECRET` |
| **Rate Limiter** | Redis Atomic Lua Script + Memory fallback | Sliding window with account and IP isolation, lockout headers |
| **CSRF Defense** | `csrf` 3.1.0 (Double-Submit Token Pattern) | `_csrf_secret` (HttpOnly) + `XSRF-TOKEN` (Readable) + header check |
| **Excel Generation** | `xlsx.full.min.js` (SheetJS) | Client-side export of master rosters and assessment matrices |
| **Word (.docx) Generation** | `docx_generator.js` + `jszip.min.js` | Generates official `ATC/T/FOR/HR/87D` evaluation sheets |
| **PDF Rendering** | `puppeteer-core` + `@sparticuz/chromium` | Server-side headless Chrome generation on Vercel |
| **Charts** | `Chart.js` v4.4.1 (CDN via cdnjs) | Subresource Integrity (SRI) verified byte-for-byte |
| **Tamil Font / Bilingual** | Embedded UTF-8 bilingual strings | Noto Sans Tamil / system Unicode rendering |

### 2.2 Client-Server Request Lifecycle
```
[ Browser / WebView / Android App ]
             │
             │ HTTPS (Cookie: signed session; Header: x-csrf-token)
             ▼
[ Vercel Edge / CDN ] (Strict Security Headers: CSP, HSTS, X-Frame-Options)
             │
             ▼
[ server.js (Express 5.2.1) ]
  ├── 1. Security Headers Middleware (OWASP Hardening)
  ├── 2. CORS Allowlist & Trusted Origin Validation
  ├── 3. Cookie Parser (Signed with SESSION_SECRET)
  ├── 4. Double-Submit CSRF Validation (Fail-closed on state-changing requests)
  ├── 5. Static Asset Allowlist (`ALLOWED_STATIC_FILES` - blocks server.js, .env, .json)
  ├── 6. Distributed Rate Limiter (Atomic Lua on Upstash Redis)
  ├── 7. Role-Based Access Control (RBAC: HR, HOD, Section, Evaluator, Employee)
  └── 8. Endpoints & Authoritative Stores
             │
             ├── Upstash Redis REST KV (Authoritative Cloud State)
             └── Local JSON Files (Fail-safe development fallback)
```

---

## 3. Data Model & Storage

### 3.1 Current Reality vs. Assumed Architecture
- **No PostgreSQL/Supabase exists in the repository.** The application currently uses:
  - In-memory JavaScript `Map` caches (`activeExamSessions`, `memoryRateCounters`).
  - Local JSON files: `custom_employees.json`, `custom_questions.json`, `assessment_records.json`, `ojt_evaluations.json`, `audit_logs.json`.
  - Upstash Redis REST KV (`syncWithCloudKv`): Key-value store holding stringified JSON payloads under `yokohama_records`, `yokohama_employees`, `yokohama_question_bank`, `yokohama_ojt_evaluations`, `yokohama_audit_logs`, `yokohama_settings`, `exam:<empNo>`.
- **Database Dependency in `package.json`:** `"mongodb": "^7.5.0"` is declared in `package.json` but is completely unused across the codebase.

### 3.2 Dataset Inventory
| Entity | Source File | Record Count | Notes / Structure |
| :--- | :--- | :--- | :--- |
| **Employees** | `custom_employees.json` / `data.js` | 1,462 employees | Quality Control: 283; Production: 1,179 |
| **Question Bank** | `custom_questions.json` / `data.js` | 720 questions | Level L: 160; Level U: 240; Level O: 320. Covers only 8 QA sections. Production questions: 0. |
| **Assessment Records** | `assessment_records.json` / Redis | Dynamic | Completed exams, scores, answers, violation logs |
| **OJT Evaluations** | `ojt_evaluations.json` / Redis | Dynamic | 10 checkpoint scores (1-5), WI adherence, evaluator remarks |
| **Audit Logs** | `audit_logs.json` / Redis | Dynamic | Timestamp, event action, actor, IP address, description |

---

## 4. Authentication, Authorization & Entry Points

The system has five distinct entry points:

### 4.1 Entry Point Analysis
| Role | Portal / Route | Auth Mechanism | Session Cookie | Authorization Scope |
| :--- | :--- | :--- | :--- | :--- |
| **HR Admin** | Management Portal (`/`, `/management`) | Admin Email + OTP (or password) | `admin_session` | Unrestricted: full employee directory, question bank editing, scheduling, resets, exports, audit logs |
| **Department HOD** | Management Portal (`/`, `/management`) | Department selector + Password | `dept_session` | Read-only scoped strictly to selected department (`QUALITY CONTROL` or `PRODUCTION`) |
| **Section Supervisor** | Management Portal (`/`, `/management`) | QA Section selector + Password | `section_session` | Scoped strictly to candidate records in assigned section |
| **Skill Evaluator** | Management Portal (`/`, `/management`) | Pillar selector (Safety, CI, QC, Tech, HR) + Password | `evaluator_session` | Access to practical OJT evaluation forms only; cannot view or edit master settings |
| **Employee** | Employee Portal (`/employee`) | Employee No + Password (self-service password setup via DOJ) | `emp_session` | Strict individual isolation: can only view own profile, upcoming scheduled exam, take exam, view past score |

### 4.2 Security Controls Implemented
1. **Password Hashing:** Passwords utilize Node.js native `crypto.scryptSync` with cryptographic salts (64-byte keys) or SHA-256 hashes.
2. **Brute Force & Rate Limiting:**
   - Account limit: 5 failed attempts per account in a 10-minute window -> 15-minute lockout.
   - IP limit: 20 failed attempts per IP address in a 10-minute window -> 15-minute lockout.
   - Redis atomic Lua script enforces INCR, EXPIRE, and temporary LOCK without race conditions.
   - `Retry-After` header sent on HTTP 429.
3. **CSRF Protection:**
   - Enforced fail-closed on all state-changing endpoints (`POST`, `PUT`, `PATCH`, `DELETE`).
   - Requires valid `_csrf_secret` cookie and matching `x-csrf-token` header.
   - Origin and Referer validated against trusted allowlist.
4. **Static Security Middleware:**
   - Strict file allowlist (`ALLOWED_STATIC_FILES`) blocks direct requests to `server.js`, `.env`, `.json`, test files, or arbitrary source code.

---

## 5. Security Scan & Dependency Audit Findings

### 5.1 Static Security Analysis
- **Semgrep CLI (v1.183.0):**
  - Rules executed: 259 rules (`p/owasp-top-ten`, `p/javascript`, `p/secrets`).
  - Files scanned: 41 tracked files.
  - Findings: **0 blocking findings, 0 warnings.**
- **OpenGrep CLI (v1.33.1):**
  - Rules executed: 459 rules (`auto` community ruleset).
  - Files scanned: 68 files.
  - Findings: **0 blocking findings, 0 warnings.**
- **Automated Regression Suite (`npm test`):**
  - Test files: 7 suites (`tests/*.test.js`).
  - Total tests: **73 tests.**
  - Result: **73 passed, 0 failed (100% pass rate).**

### 5.2 Dependency Audit (`npm audit`)
- **Vulnerabilities:** 3 moderate vulnerabilities in transitive dev dependencies:
  - `glob` (>=9.0.0 <=14.0.1): AbortSignal cancellation bypass (CWE-400).
  - `minimatch` (>=7.0.0 <11.0.1): Denial of service via globparts amplification (CWE-405).
  - `rimraf` (4.2.0 - 6.1.3): Transitive dependency via `glob`.
- **Unused Packages:**
  - `mongodb` v7.5.0: Installed in `package.json`, completely unused. Should be removed to reduce attack surface and deployment footprint.

---

## 6. Discrepancies, Logic Gaps & Hardcoded Constants

During code inspection, the following critical inconsistencies and hardcoded values were cataloged:

### 6.1 Exam Eligibility Experience Gap (Issue B1)
- **Current Matrix in `index.html`:**
  - Level L: 7 to 90 days.
  - Level U: 3 months to 2 years.
  - Level O: > 4 years.
- **The Gap:** Employees with **between 2 years and 4 years of experience (24 to 48 months)** are completely excluded from the eligibility matrix! They cannot qualify for Level O under the current rule.
- **Remediation Requirement:** Define a continuous eligibility function where 2+ years qualifies for Level U to Level O promotion, or document the exact plant HR policy in `docs/ASSUMPTIONS.md`.

### 6.2 Conflicting Pass Mark Thresholds (Issue B2)
- `server.js` line 2583: Checks `>= 50%` (`correctCount / totalQuestions >= 0.5`).
- `app.js` UI matrix text: Displays `> 50%`.
- `app.js` Security Settings default input: Pre-fills `70%`.
- `app.js` Excel export formula: Implements tiered thresholds `L >= 50%, U >= 60%, O >= 75%`.
- `index.html` OJT threshold text: States `≥ 70%` (35/50 marks).
- **Remediation Requirement:** Establish a single source of truth in configuration/database for pass marks, ensuring consistency across grading, UI badges, training alerts, and reports.

### 6.3 Hardcoded Strings vs. Dynamic Counts (Issue B3)
- Public HTML text contains static strings:
  - `"1,462 employees (1,179 Production + 283 QA across 33 sections)"`
  - `"720 questions"`
  - `"283 Total Employees"`
  - `"8 QA Sections"`
- Live counters briefly show `0` on load before popping to static or fetched numbers.
- **Remediation Requirement:** Remove static strings; bind all counter elements to dynamic backend aggregates with skeleton loading states.

### 6.4 Inconsistent Section & Department Naming (Issues B4 & B5)
- **Section Count Reconciliation (33 Total Sections):**
  - **Quality Control:** Exactly **8 canonical QA sections** match the 720 questions in the master bank: `Tire Building QA`, `Tire Curing QA`, `Final Finish QA`, `Final Finish RRO & ALT QA`, `Preparatory QA`, `Solid Tire QA`, `Warehouse QA`, and `FID Inspector QA`.
  - The employee roster contained 10 raw entries because sub-sections (`Data Entry QA`, `FINAL FINISH`, `Final Finish ALT QA`, `Final Finish RRO QA`) appeared as separate strings. These map directly into the 8 canonical QA sections.
  - **Production:** Exactly **25 manufacturing sections**.
  - **Total Reconciled Sections:** 8 QA + 25 Production = **33 operational manufacturing sections**.
- Production spelling anomalies:
  - `"TYRE CURING"` vs `"Tire curing QA"` (Tyre vs Tire)
  - Legacy/typo names: `"YANTHAI"`, `"BIAS MARANGONI&BESTRY"`
- **Remediation Requirement:** Introduce a canonical `sections` table/schema with standardized codes (e.g., `TB`, `FF`, `PR`, `ST`, `WH`, `TC`, `RA`, `FD`) and consistent title casing adhering to `docs/GLOSSARY.md`.

### 6.5 Production Staff Exam Void (Issue B8)
- 1,179 production employees across 25 production sections are rostered in `custom_employees.json`.
- The question bank (`custom_questions.json`) has **0 questions for Production sections** (all 720 questions belong to 8 QA sections).
- Production staff cannot advance ILUO levels through the portal without approved question banks.
- **Remediation Requirement:** Per stakeholder decision, provide a dedicated non-promotional "Manufacturing Foundation Module" (Safety, CI & TPM, Quality) recorded as compliance training without changing ILUO skill levels. Section-specific exams remain locked until section question banks are uploaded.

### 6.6 Admin Surface Exposure (Issue S1)
- `index.html` currently bundles markup for all 5 roles (HR Control Center, HOD Dashboard, Section Portal, OJT Form, Reset All Exams modal, Security Settings modal) into one 2,300-line file served to every visitor.
- Although protected by client-side CSS and server-side API auth, anyone viewing source or inspecting DOM can see the administrative structure.
- **Remediation Requirement:** Route-level code chunking separating `/` (public login hub), `/management` (administrative portal), and `/employee` (shop-floor candidate view).

---

## 7. Operational & Production Risks

1. **Redis Connectivity & Multi-Instance Serverless State:**
   - In production on Vercel, requests fan out across multiple serverless execution contexts.
   - If `UPSTASH_REDIS_REST_URL` or `UPSTASH_REDIS_REST_TOKEN` encounters write permission failures (such as the observed HTTP 403 Forbidden error during test runs), the system must fail-closed safely for authentication while maintaining resilience for in-progress exam sessions.
2. **Tamil Text & Document Formatting:**
   - Official compliance audits require exact formatting for Form `ATC/T/FOR/HR/87D`.
   - Tamil characters must be preserved without UTF-8 corruption during JSON parsing, Excel workbook generation, and PDF printing.

---

## 8. Conclusion & Sign-Off

Reconnaissance has verified the concrete code realities, security scanners, dependencies, and business logic across all 11 security items and 13 logic/data consistency items. All items requiring plant policy verification (eligibility transition months, tiered pass marks, OJT thresholds) are explicitly cataloged as `PENDING HR CONFIRMATION` in `docs/ASSUMPTIONS.md`. The implementation plan in `docs/PLAN.md` provides the exact step-by-step roadmap for executing Phases 2 through 8 on branch `audit/full-fix`.
