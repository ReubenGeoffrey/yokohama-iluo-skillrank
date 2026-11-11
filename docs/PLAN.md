# ATC Tires ILUO Portal Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the ATC Tires ILUO Skill Assessment Portal into a secure, enterprise-grade, strictly-typed, and accessible platform with verified security defenses, relational database schema, WCAG 2.2 AA compliant UI, and complete candidate/admin lifecycles.

**Architecture:** Express/Node backend modularized with strict TypeScript and separate route-level code chunks for `/` (public login hub), `/management` (administrative portal), and `/employee` (isolated shop-floor candidate view), backed by an authoritative persistence adapter (PostgreSQL/Supabase + Upstash Redis cache), server-side exam grading, and Playwright E2E verification.

**Tech Stack:** Node.js, Express 5.2.1, TypeScript (strict), PostgreSQL / Supabase, Upstash Redis, Playwright, SheetJS (`xlsx`), docx/jszip, puppeteer-core, sparticuz-chromium, Semgrep, OpenGrep.

**Spec:** `docs/RECON.md`, `docs/ASSUMPTIONS.md`, `docs/GLOSSARY.md`, and `AGY_FIX_PROMPT_ILUO_PORTAL.md`.

---

## Global Constraints

1. **Branch Discipline:** All work must remain on git branch `audit/full-fix`. Never commit directly to `main`.
2. **Zero Inventions:** Strictly follow business rules and canonical naming defined in `docs/ASSUMPTIONS.md` and `docs/GLOSSARY.md`.
3. **Fail-Closed Security:** No authorization decision shall depend on client-side code; answer keys must never reach the browser; destructive actions require typed confirmation and audit logging.
4. **Bilingual Preservation:** Full Tamil and English bilingual fidelity must be preserved in UI, questions, and exports.
5. **No Blind Code Changes:** Every change must be verified with automated regression tests before and after implementation.

---

## Review Focus

1. **Answer Key Leakage:** Ensure no exam response payload contains `correctAnswer` or hints that could be intercepted by browser inspection or proxy tools.
2. **Horizontal Privilege Escalation (IDOR):** Verify that an authenticated employee cannot fetch or alter assessment records or OJT scores belonging to another employee number.
3. **Fail-Closed Rate Limiting:** Verify that if Redis is offline or write-restricted in production, authentication fails closed safely rather than allowing unmetered brute-force attempts.
4. **Tamil Font Encoding & MoJiBake:** Confirm that Tamil question text and candidate names render correctly without corruption during PDF and Excel exports.
5. **Exam Lifecycle Resilience:** Ensure that temporary browser blur, tab switches, network drops, or power loss do not cause permanent exam loss for shop-floor candidates.

---

## Task Decomposition

### Phase 2: Security & Logic Bug Remediation

#### Task 2.1: Admin Surface Isolation & Role-Based Chunking (Issue S1)
- [ ] Create dedicated route handlers and static asset bundles separating the public landing hub (`/`), the administrative portal (`/management`), and the candidate portal (`/employee`).
- [ ] Remove administrative markup, reset dialogs, and master rosters from the initial public HTML.
- [ ] Implement middleware ensuring `/management` requires valid `admin_session`, `dept_session`, `section_session`, or `evaluator_session`.
- [ ] Add regression test verifying unauthenticated GET requests to administrative views redirect to `/` or return HTTP 401/403.
- [ ] Commit task changes with message `fix(security): isolate admin surface behind server-side authentication gate`.

#### Task 2.2: Answer Key Protection & Server-Authoritative Grading (Issues S4 & S6)
- [ ] Verify `sanitizeQuestionsForEmployee` strips `correctAnswer` from all candidate endpoints (`/api/exam/start`, `/api/questions`).
- [ ] Implement question randomization per candidate attempt, selecting questions across required categories while shuffling options.
- [ ] Record the randomized question ID sequence per exam attempt in persistent storage.
- [ ] Ensure `scoreAssessmentServerSide` strictly evaluates submitted answers on the server and computes final marks.
- [ ] Run test suite to verify zero answer key leakage and authoritative score calculation.
- [ ] Commit task changes with message `fix(exam): enforce randomized questions and authoritative server-side grading`.

#### Task 2.3: Exam Integrity & Server-Authoritative Timer (Issue S5)
- [ ] Store exam `startTime`, `expiresAt`, and duration authoritatively on the server.
- [ ] Reject exam submissions timestamped past `expiresAt + gracePeriod` (HTTP 410 Gone / 400 Bad Request).
- [ ] Track tab switches via server API `/api/exam/violation` and enforce maximum threshold with HR reinstatement override.
- [ ] Verify test suite covers late submission rejection and tab-switch logging.
- [ ] Commit task changes with message `fix(exam): implement server-authoritative timer and violation tracking`.

#### Task 2.4: Gated Destructive Actions & Removal of Demo Buttons (Issue S7)
- [ ] Remove "Restore Demo Completed" and demo data mixing from production builds.
- [ ] Require typed confirmation phrase (e.g., section name or `"CONFIRM RESET"`) for all destructive reset endpoints.
- [ ] Implement impact preview endpoint returning affected candidate count before execution.
- [ ] Log all destructive actions to the persistent audit log.
- [ ] Verify negative tests for reset endpoints without confirmation phrases.
- [ ] Commit task changes with message `fix(security): gate destructive actions with typed confirmation and audit logging`.

#### Task 2.5: XSS Sanitization, Formula Injection & HTTP Hardening (Issues S8 & S9)
- [ ] Sanitize all employee names, question text, and uploaded data before DOM injection.
- [ ] Implement formula injection defense in Excel and CSV exports by escaping cells starting with `=`, `+`, `-`, `@`.
- [ ] Configure strict Content-Security-Policy (CSP) headers without unhashed inline scripts in `server.js` and `vercel.json`.
- [ ] Enforce `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] Verify security headers via automated test.
- [ ] Commit task changes with message `fix(security): harden CSP, sanitize inputs, and prevent spreadsheet formula injection`.

#### Task 2.6: Dependency Audit & Unused Package Cleanup (Issue S11)
- [ ] Uninstall unused `mongodb` package from `package.json`.
- [ ] Update direct dependencies to resolve moderate advisories in `glob` and `minimatch`.
- [ ] Run `npm audit` to verify vulnerability remediation.
- [ ] Commit task changes with message `chore(deps): prune unused mongodb dependency and resolve audit vulnerabilities`.

#### Task 2.7: Logic Gaps, Eligibility Gap & Pass Mark Standardization (Issues B1 & B2)
- [ ] Implement pure eligibility function in `eligibility.js` eliminating the 2-4 year experience gap (24+ months qualifies for Level O).
- [ ] Standardize pass mark threshold single source of truth across all modules (MCQ >= 50%, OJT >= 70%).
- [ ] Update UI badges, Excel export formulas, and server-side evaluation to read canonical thresholds.
- [ ] Write unit tests verifying edge cases (7 days, 90 days, 24 months, 48 months).
- [ ] Commit task changes with message `fix(logic): eliminate eligibility gap and standardize pass mark thresholds`.

#### Task 2.8: Canonical Taxonomy & Section Normalization (Issues B3, B4, B5, B6, B7, B9)
- [ ] Replace static hardcoded strings ("1,462 employees", "720 questions") with dynamic backend aggregates.
- [ ] Create `taxonomy.js` implementing canonical section mappings according to `docs/GLOSSARY.md`.
- [ ] Standardize "Tire" vs "Tyre" spelling and normalize all section dropdowns.
- [ ] Remove stray UI elements ("Message notification", unauthenticated sign-out headers).
- [ ] Commit task changes with message `fix(ui): enforce canonical taxonomy and bind live metrics dynamically`.

---

### Phase 3: Database Architecture (PostgreSQL / Supabase)

#### Task 3.1: Relational Schema & Migration Engineering
- [ ] Author `docs/DB_SCHEMA.md` detailing the complete entity-relationship diagram and role-based access matrix.
- [ ] Create migration script `migrations/001_initial_schema.sql` defining:
  - Tables: `departments`, `sections`, `employees`, `profiles`, `questions`, `question_options`, `exam_configs`, `exam_schedules`, `exam_attempts`, `attempt_answers`, `ojt_evaluations`, `ojt_checkpoint_scores`, `training_requirements`, `security_settings`, `audit_logs`.
  - Primary keys, foreign keys, `CHECK` constraints, `created_at`/`updated_at` triggers.
  - Performance indexes on frequently filtered columns (`section_id`, `emp_no`, `target_level`, `status`).
- [ ] Define comprehensive Row Level Security (RLS) policies for each role (`hr_admin`, `dept_hod`, `section_head`, `evaluator`, `employee`).
- [ ] Create `migrations/002_seed_data.sql` with isolated development seed data.
- [ ] Commit task changes with message `feat(db): design relational PostgreSQL/Supabase schema and migrations`.

#### Task 3.2: Typed Database Adapter Layer
- [ ] Create `src/db/adapter.ts` providing an abstraction layer over PostgreSQL/Supabase and Upstash Redis.
- [ ] Implement fallback to local JSON/Redis when PostgreSQL connection strings are omitted.
- [ ] Verify data persistence and transaction atomicity across assessment workflows.
- [ ] Commit task changes with message `feat(db): implement typed database persistence adapter`.

---

### Phase 4: Strict TypeScript Conversion

#### Task 4.1: TypeScript & Linting Toolchain Configuration
- [ ] Install `typescript`, `@types/node`, `@types/express`, `zod`, `typescript-eslint`, and `prettier`.
- [ ] Configure `tsconfig.json` with strict flags:
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `noImplicitOverride: true`
- [ ] Define Zod schemas in `src/types/schemas.ts` for all boundary inputs (logins, submissions, OJT scores, imports).
- [ ] Commit task changes with message `chore(ts): configure strict TypeScript toolchain and Zod validation schemas`.

#### Task 4.2: Backend TypeScript Migration
- [ ] Migrate `server.js` and server utilities into typed modules under `src/server/`.
- [ ] Replace string literals with discriminated unions (`SkillLevel`, `DepartmentCode`, `AssessmentStatus`).
- [ ] Ensure build passes with zero TypeScript compiler errors (`tsc --noEmit`).
- [ ] Commit task changes with message `refactor(server): migrate backend to strict TypeScript with zero type errors`.

---

### Phase 5: UI/UX Redesign (Better Design & UI/UX Pro Max)

#### Task 5.1: Enterprise Design System & Accessibility Baseline
- [ ] Define design tokens for color (Primary Yokohama Blue `#005B9E`, semantic success/warning/danger), typography (Noto Sans Tamil + system sans-serif), spacing, and elevation.
- [ ] Replace all emoji icons with crisp, accessible SVG icon components.
- [ ] Ensure all form controls, modals, and buttons satisfy WCAG 2.2 AA (4.5:1 contrast, focus rings, `aria-label` on dismiss controls).
- [ ] Add English / Tamil bilingual language toggle.
- [ ] Commit task changes with message `feat(ui): implement enterprise design system and accessible SVG icon library`.

#### Task 5.2: Streamlined Portal Hub & Role Dashboards
- [ ] Redesign `/` landing hub with clear role cards (Department HOD, HR Login, Section Login, Skill Assessment, Employee Self-Service).
- [ ] Redesign Employee Self-Service portal with responsive KPI cards, upcoming exam schedule card, and eligibility badge.
- [ ] Redesign HR Control Center with sticky table headers, multi-column sorting, and URL-persisted filters.
- [ ] Redesign OJT digital evaluation sheet matching paper Form `ATC/T/FOR/HR/87D`.
- [ ] Commit task changes with message `feat(ui): redesign portal hub, employee dashboard, and OJT digital form`.

#### Task 5.3: Focused Exam Candidate Experience
- [ ] Redesign exam view with distraction-free layout, persistent countdown timer, question palette (answered/unanswered/flagged), and autosave indicator.
- [ ] Implement confirm-before-submit summary dialog.
- [ ] Commit task changes with message `feat(ui): implement distraction-free candidate exam interface with autosave`.

---

### Phase 6: Enterprise Features

#### Task 6.1: Audit Log Viewer & User Management
- [ ] Implement visual Audit Log Viewer in HR Control Center with filtering by actor, action type, and date range.
- [ ] Implement individual user account management with role claims.
- [ ] Commit task changes with message `feat(admin): implement security audit log viewer and account management`.

#### Task 6.2: Employee Self-Service & Digital Certificates
- [ ] Implement candidate certificate preview and download upon passing both MCQ and OJT evaluations.
- [ ] Display historical assessment timeline on employee dashboard.
- [ ] Commit task changes with message `feat(employee): add self-service digital certificate and assessment timeline`.

#### Task 6.3: Autosave, Exam Resume & Reassessment Scheduler
- [ ] Implement local and cloud autosave heartbeat (`/api/exam/autosave`) every 30 seconds.
- [ ] Support seamless resume for interrupted sessions within the allotted exam duration window.
- [ ] Implement retraining and reassessment calendar scheduler linked to Training Requirement matrix.
- [ ] Commit task changes with message `feat(exam): implement autosave, exam resume, and reassessment scheduler`.

#### Task 6.4: Bulk Import & Complete System Export
- [ ] Implement bulk Excel/Word import with dry-run validation preview and row-level error reporting.
- [ ] Provide one-click full system backup (JSON/XLSX export) and document restore procedures.
- [ ] Commit task changes with message `feat(data): implement transactional bulk import and system backup exports`.

---

### Phase 7: Playwright End-to-End Testing Suite

#### Task 7.1: Playwright Framework Setup & Configuration
- [ ] Configure `playwright.config.ts` covering Chromium, Firefox, WebKit, and mobile viewport emulation (Pixel 7, iPhone 14).
- [ ] Implement database seed and reset fixtures in `tests/e2e/fixtures.ts`.
- [ ] Commit task changes with message `test(e2e): configure Playwright test framework and fixtures`.

#### Task 7.2: Critical User Journey & Authorization Specifications
- [ ] Implement E2E tests for all 5 login flows and session lifecycle.
- [ ] Implement strict authorization tests (IDOR, role boundaries, unauthenticated API access rejection).
- [ ] Implement complete candidate exam journey: schedule → take exam → timer countdown → autosave → submit → score calculation → report generation.
- [ ] Implement OJT scoring, double-submit rejection, and typed reset flows.
- [ ] Run `@axe-core/playwright` accessibility checks across all primary views.
- [ ] Commit task changes with message `test(e2e): implement comprehensive Playwright authorization and lifecycle suites`.

---

### Phase 8: Final Verification & Documentation

#### Task 8.1: Full Security & Quality Audit Verification
- [ ] Run full Semgrep and OpenGrep scans to verify 0 blocking vulnerabilities.
- [ ] Run complete test suite (`npm test` and Playwright) ensuring 100% pass rate.
- [ ] Run TypeScript compiler and ESLint ensuring zero errors.
- [ ] Commit task changes with message `chore(verify): execute final multi-scanner security and quality verification`.

#### Task 8.2: Deliverables & Operational Runbooks
- [ ] Write `docs/AUDIT_REPORT.md` with complete vulnerability triage, resolution evidence, and key rotation recommendations.
- [ ] Write `docs/RUNBOOK.md` detailing deployment, rollback, backup/restore, and user management procedures.
- [ ] Update `README.md` and record all changes in `docs/AUDIT_LOG.md`.
- [ ] Commit task changes with message `docs: publish audit report, operational runbook, and project documentation`.
