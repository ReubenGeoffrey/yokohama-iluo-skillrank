# ATC Tires ILUO Portal Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the ATC Tires ILUO Skill Assessment Portal into a secure, enterprise-grade, strictly-typed, and accessible platform with verified security defenses, relational database schema, WCAG 2.2 AA compliant UI, and complete candidate/admin lifecycles.

**Architecture:** Express/Node backend modularized with strict TypeScript and separate route-level code chunks for `/` (public login hub), `/management` (administrative portal), and `/employee` (isolated shop-floor candidate view), backed by an authoritative persistence adapter (PostgreSQL/Supabase + Upstash Redis cache), server-side exam grading, and Playwright E2E verification.

**Tech Stack:** Node.js, Express 5.2.1, TypeScript (strict), PostgreSQL / Supabase, Upstash Redis, Playwright, SheetJS (`xlsx`), docx/jszip, puppeteer-core, sparticuz-chromium, Semgrep, OpenGrep, Capacitor 8.5.2.

**Spec:** `docs/RECON.md`, `docs/ASSUMPTIONS.md`, `docs/GLOSSARY.md`, and `AGY_FIX_PROMPT_ILUO_PORTAL.md`.

---

## Global Constraints

1. **Branch Discipline:** All work must remain on git branch `audit/full-fix`. Never commit directly to `main`.
2. **Zero Inventions:** Strictly follow business rules and canonical naming defined in `docs/ASSUMPTIONS.md` and `docs/GLOSSARY.md`. All items awaiting plant management sign-off are marked `[PENDING HR CONFIRMATION]`.
3. **Fail-Closed Security:** No authorization decision shall depend on client-side code; answer keys and rosters must never reach unauthenticated clients; destructive actions require typed confirmation and audit logging.
4. **Production Fail-Closed:** The Vercel filesystem is read-only and ephemeral; in production, storage failures must return HTTP 503 instead of falling back to local JSON.
5. **Bilingual Preservation:** Full Tamil and English bilingual fidelity must be preserved in UI, questions, and exports.
6. **Evidence Before Assertions:** For every completed task, provide commit hash, test/scan command outputs, and the list of modified files.

---

## Review Focus

1. **Answer Key & Roster Leakage:** Ensure no static files (`data.js`) or API responses serve employee rosters or questions with `correctAnswer` to unauthenticated clients.
2. **Horizontal Privilege Escalation (IDOR):** Verify that an authenticated employee cannot fetch or alter assessment records or OJT scores belonging to another employee number.
3. **Fail-Closed Rate Limiting & Storage:** Verify that if Redis/Postgres is offline or write-restricted in production, authentication and writes fail closed safely with HTTP 503.
4. **Tamil Font Encoding & MoJiBake:** Confirm that Tamil question text and candidate names render correctly without corruption during PDF and Excel exports.
5. **Exam Lifecycle Resilience:** Ensure that autosave and resume protect candidates against power drops or browser blur before enforcing tab-switch auto-termination.

---

## Task Decomposition

### Phase 2: Security & Logic Bug Remediation [COMPLETED]

#### Task 2.1: Client Asset Isolation & Data Leakage Prevention (S1 & S4) [COMPLETED - Commit `3f9de83`]
- [x] Check whether `data.js`, `seed_data.js`, or any static file served publicly contains employees or questions with correct answers.
- [x] Remove `data.js` and `seed_data.js` from client `<script>` delivery and the `ALLOWED_STATIC_FILES` public allowlist.
- [x] Isolate administrative markup chunks behind server-side authentication gates (`/management` vs `/` vs `/employee`).
- [x] Deliver sanitized, scoped data only through authenticated API endpoints (`/api/questions`, `/api/employees`).
- [x] Add regression test verifying unauthenticated GET requests to administrative views and data scripts are rejected with HTTP 401/403.
- [x] Commit task changes with message `fix(security): eliminate public client delivery of rosters, answer keys, and admin markup`.

#### Task 2.2: Individual Account Architecture & Role Claims (S2) [COMPLETED - Commit `64cdb4e`]
- [x] Eliminate shared role passwords (`section123`, `hod123`, `ci123`, `quality123`, etc.).
- [x] Implement individual user accounts with unique identifiers (email for admin/HOD/evaluators, employee ID for staff).
- [x] Store cryptographically hashed passwords and assign explicit role claims: `hr_admin`, `dept_hod`, `section_head`, `evaluator`, `employee`.
- [x] Enforce session expiry (8 hours default, 45 minutes for active exams) and write audit logs for all login events.
- [x] Add regression tests verifying shared passwords are rejected and individual role claims are strictly enforced.
- [x] Commit task changes with message `fix(auth): implement individual user accounts and eliminate shared passwords`.

#### Task 2.3: Employee Password Setup Hardening & Hash Migration [COMPLETED - Commit `57a438d`]
- [x] Review employee self-service password setup: replace Date-of-Joining (DOJ) alone with a one-time token / OTP dispatched via email/SMS or issued by HR.
- [x] Implement transparent password hash migration: detect legacy unsalted SHA-256 hashes and upgrade them to `scrypt` with a fresh 16-byte cryptographic salt on next successful login.
- [x] Add automated tests for token-based password setup and transparent hash migration.
- [x] Commit task changes with message `fix(auth): require one-time token for password setup and migrate legacy hashes to scrypt`.

#### Task 2.4: Inline Event Handler Refactoring for Strict CSP [COMPLETED - Commit `27ee50c`]
- [x] Audit all HTML templates (`index.html`, `employee.html`) and scripts for inline `onclick="..."`, `onchange="..."`, `onsubmit="..."` attributes.
- [x] Refactor all inline event handlers to programmatic `addEventListener` calls.
- [x] Update Content-Security-Policy (CSP) headers in `server.js` and `vercel.json` to eliminate `unsafe-inline` for scripts.
- [x] Verify CSP compliance using automated header checks.
- [x] Commit task changes with message `refactor(ui): remove inline event handlers to enable strict Content-Security-Policy`.

#### Task 2.5: Question Bank Capacity & Shortfall Management (S6) [COMPLETED - Commit `0294ba6`]
- [x] Audit current question pool: 720 questions across 8 QA sections = exactly 90 questions per section (20 L + 30 U + 40 O), matching exactly one fixed paper per candidate.
- [x] Implement dynamic pool selector in grading engine supporting question pools larger than exam size.
- [x] Implement per-attempt question randomization and option shuffling, recording the exact question ID array in the candidate's exam record.
- [x] Surface a prominent audit warning to HR in the management dashboard flagging the single-paper shortfall until additional questions are authored.
- [x] Add tests verifying question selection randomness and persistent attempt question mapping.
- [x] Commit task changes with message `feat(exam): implement question randomization and audit alert for pool capacity shortfall`.

#### Task 2.6: Autosave & Exam Resume (Pre-requisite for S5) [COMPLETED - Commit `8428fe4`]
- [x] Implement client-side periodic autosave (every 30 seconds) and server autosave endpoint `/api/exam/autosave`.
- [x] Persist current question index, elapsed time, and responses in both client sessionStorage and server exam session.
- [x] Implement resume workflow for interrupted sessions (power cut, network drop, page reload) within the remaining duration window.
- [x] Add tests verifying state preservation and recovery across simulated disconnects.
- [x] Commit task changes with message `feat(exam): implement autosave and seamless session resume for candidates`.

#### Task 2.7: Exam Integrity & Server-Authoritative Timer (S5) [COMPLETED - Commit `8428fe4`]
- [x] Store exam `startTime`, `expiresAt`, and duration authoritatively on the server; reject late submissions (HTTP 410 / 400).
- [x] Implement tab-switch tracking via `/api/exam/violation` using Page Visibility API and window blur events with a 3-second grace period to prevent false positives.
- [x] Enforce auto-terminate threshold (3 violations) and implement an HR review/reinstatement mechanism.
- [x] Add automated tests for late submission rejection and violation tracking.
- [x] Commit task changes with message `fix(exam): enforce server-authoritative timer and resilient tab-switch termination`.

#### Task 2.8: Server-Authoritative Grading & Answer Key Protection (S4) [COMPLETED - Verified in Tests]
- [x] Verify `sanitizeQuestionsForEmployee` strips `correctAnswer` from all candidate endpoints (`/api/exam/start`, `/api/questions`).
- [x] Implement authoritative server-side scoring function `scoreAssessmentServerSide` calculating marks against secure master bank.
- [x] Add regression tests ensuring candidate payloads contain zero answer keys and scores are computed authoritatively on the server.
- [x] Commit task changes with message `fix(exam): enforce server-authoritative scoring and zero answer key disclosure`.

#### Task 2.9: Gated Destructive Actions & Removal of Demo Buttons (S7) [COMPLETED - Commit `7e4a828`]
- [x] Remove "Restore Demo Completed" and demo data mixing from production builds.
- [x] Require typed confirmation phrase (e.g., section name or `"CONFIRM RESET"`) for all destructive reset endpoints.
- [x] Implement impact preview endpoint returning affected candidate count before execution.
- [x] Log all destructive actions to the persistent audit log.
- [x] Add negative tests verifying unconfirmed reset attempts are rejected.
- [x] Commit task changes with message `fix(security): gate destructive actions with typed confirmation and audit logging`.

#### Task 2.10: Injection Defense, Formula Sanitization & HTTP Hardening (S8 & S9) [COMPLETED - Commit `334c007`]
- [x] Sanitize all employee names, question text, and uploaded data before DOM injection.
- [x] Implement formula injection defense in Excel and CSV exports by escaping cells starting with `=`, `+`, `-`, `@`.
- [x] Enforce security headers: CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`.
- [x] Verify headers and formula escaping via automated tests.
- [x] Commit task changes with message `fix(security): harden HTTP headers, sanitize inputs, and prevent formula injection`.

#### Task 2.11: Dependency Audit & Unused Package Cleanup (S11) [COMPLETED - Commit `6bc8919`]
- [x] Uninstall unused `mongodb` package from `package.json`.
- [x] Update direct dependencies to resolve moderate advisories in `glob` and `minimatch`.
- [x] Run `npm audit` to verify vulnerability remediation.
- [x] Commit task changes with message `chore(deps): prune unused mongodb dependency and resolve audit vulnerabilities`.

#### Task 2.12: Configurable Eligibility & Tiered Pass Mark Standards (B1 & B2) [COMPLETED - Commit `e9f66a3`]
- [x] Implement pure eligibility function based on `currentLevel` and configurable minimum service months per transition (`I→L`, `L→U`, `U→O` default 24m, marked `[PENDING HR CONFIRMATION]`).
- [x] Implement single configuration source for tiered pass marks (`L >= 50%`, `U >= 60%`, `O >= 75%`, OJT `70%`, marked `[PENDING HR CONFIRMATION]`).
- [x] Update UI badges, Excel export formulas, and server-side evaluation to read canonical thresholds.
- [x] Write unit tests verifying edge cases (7 days, 90 days, 24 months).
- [x] Commit task changes with message `fix(logic): implement transition-based eligibility and configurable pass marks`.

#### Task 2.13: Standalone Manufacturing Foundation Module (B8) [COMPLETED - Commit `e9f66a3`]
- [x] Create dedicated "Manufacturing Foundation Module" (Safety, CI & TPM, General Quality) for Production staff.
- [x] Ensure Foundation Module completion is recorded as compliance training but NEVER increments or changes ILUO skill level.
- [x] Lock section-specific level exams for any section lacking an approved section question bank.
- [x] Add automated tests verifying Foundation Module completion does not alter candidate ILUO level.
- [x] Commit task changes with message `feat(exam): implement standalone foundation module and lock unprovisioned section exams`.

#### Task 2.14: Canonical Taxonomy & Live Metric Binding (B3, B4, B5, B6, B7, B9) [COMPLETED - Commit `e9f66a3`]
- [x] Reconcile total sections to exactly 33 (8 QA + 25 Production) adhering to `docs/GLOSSARY.md`.
- [x] Normalize section aliases (`FINAL FINISH`, `Data Entry QA`, `Final Finish ALT QA`) into canonical codes.
- [x] Standardize plant spelling to "Tire" and replace static hardcoded numbers with live database aggregates.
- [x] Remove stray UI artifacts ("Message notification", unauthenticated sign-out headers).
- [x] Commit task changes with message `fix(ui): enforce canonical 33-section taxonomy and bind live metrics dynamically`.

#### Task 2.15: Capacitor & Android Hybrid Architecture Review [COMPLETED - Commit `f5932d1`]
- [x] Review `capacitor.config.json` and native Android wrapper for secure configuration.
- [x] Ensure API base URL is dynamically configurable for both local development and remote Vercel production.
- [x] Configure CORS and CSRF token handling to permit requests from Capacitor WebView origins (`capacitor://localhost`, `http://localhost`).
- [x] Review on-device storage to ensure no sensitive master data is stored unencrypted in local WebView storage.
- [x] Add tests or verification scripts for mobile origin requests.
- [x] Commit task changes with message `fix(mobile): review Capacitor Android configuration and secure WebView API access`.

---

### Phase 3: Strict TypeScript Toolchain & Schemas (Reordered)

#### Task 3.1: TypeScript & Linting Toolchain Configuration
- [ ] Install `typescript`, `@types/node`, `@types/express`, `zod`, `typescript-eslint`, and `prettier`.
- [ ] Configure `tsconfig.json` with strict compiler flags:
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `noImplicitOverride: true`
- [ ] Define Zod schemas in `src/types/schemas.ts` for all boundary entities (logins, questions, exam submissions, OJT scores, bulk imports).
- [ ] Commit task changes with message `chore(ts): configure strict TypeScript toolchain and Zod validation schemas`.

#### Task 3.2: Server & Domain Logic TypeScript Migration
- [ ] Migrate `server.js` and server utilities into typed modules under `src/server/`.
- [ ] Replace string literals with discriminated unions (`SkillLevel`, `DepartmentCode`, `AssessmentStatus`).
- [ ] Ensure build passes with zero TypeScript compiler errors (`tsc --noEmit`).
- [ ] Commit task changes with message `refactor(server): migrate backend to strict TypeScript with zero type errors`.

---

### Phase 4: Database Architecture & Migration Engineering

#### Task 4.1: Relational Schema & Migration Engineering
- [ ] Author `docs/DB_SCHEMA.md` detailing the complete entity-relationship diagram and role-based access matrix.
- [ ] Create migration script `migrations/001_initial_schema.sql` defining:
  - Tables: `departments`, `sections`, `employees`, `profiles`, `questions`, `question_options`, `exam_configs`, `exam_schedules`, `exam_attempts`, `attempt_answers`, `ojt_evaluations`, `ojt_checkpoint_scores`, `training_requirements`, `security_settings`, `audit_logs`.
  - Primary keys, foreign keys, `CHECK` constraints, `created_at`/`updated_at` triggers.
  - Performance indexes on frequently filtered columns (`section_id`, `emp_no`, `target_level`, `status`).
- [ ] Define comprehensive Row Level Security (RLS) policies for each role (`hr_admin`, `dept_hod`, `section_head`, `evaluator`, `employee`).
- [ ] Document database connection model: Express backend connects via direct connection pool or Supabase service-role key, with RLS acting as defense-in-depth, enforcing tenant/role claims in Express middleware.
- [ ] Commit task changes with message `feat(db): design relational PostgreSQL/Supabase schema and migrations`.

#### Task 4.2: Data-Migration Plan (Redis/JSON → PostgreSQL) & Typed Adapter
- [ ] Create data-migration script `scripts/migrate-to-postgres.js` with:
  - Dry-run validation mode.
  - Dual-write capability during rollout.
  - Row count and checksum verification.
  - Documented rollback plan in `docs/RUNBOOK.md`.
- [ ] Enforce production fail-closed rule: in production (`NODE_ENV === 'production'`), storage failures must return HTTP 503; no local-JSON fallback on Vercel.
- [ ] Implement `src/db/adapter.ts` wrapping PostgreSQL/Supabase and Upstash Redis.
- [ ] Verify data persistence and transaction atomicity across assessment workflows.
- [ ] Commit task changes with message `feat(db): implement data migration pipeline and fail-closed database adapter`.

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

#### Task 6.1: Audit Log Viewer & Individual Account Management
- [ ] Implement visual Audit Log Viewer in HR Control Center with filtering by actor, action type, and date range.
- [ ] Implement individual user account management interface with role claims assignment.
- [ ] Commit task changes with message `feat(admin): implement security audit log viewer and account management`.

#### Task 6.2: Employee Self-Service & Digital Certificates
- [ ] Implement candidate certificate preview and download upon passing both MCQ and OJT evaluations.
- [ ] Display historical assessment timeline on employee dashboard.
- [ ] Commit task changes with message `feat(employee): add self-service digital certificate and assessment timeline`.

#### Task 6.3: Reassessment & Retraining Scheduler
- [ ] Implement retraining and reassessment calendar scheduler linked to Training Requirement matrix.
- [ ] Support due-date reminders and status tracking for candidates requiring retest.
- [ ] Commit task changes with message `feat(exam): implement reassessment and retraining scheduler`.

#### Task 6.4: Transactional Bulk Import & Complete System Export
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
- [ ] Implement E2E tests for all 5 individual login flows and session lifecycle.
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
