# Yokohama ILUO Skill Assessment Portal — Dual-Portal Deployment Guide

This document describes the architectural design, environment configuration, local development, and Vercel production deployment for the two connected applications:
1. **Management Portal** (`management.yourdomain.in` / `yokohama-iluo-portal.vercel.app`)
2. **Employee Portal** (`employee.yourdomain.in` / `yokohama-iluo-employee.vercel.app`)

---

## 1. System Architecture

Both websites operate independently on the frontend while connecting to the same authoritative backend, session engine, and database:

```text
┌─────────────────────────────────────────┐     ┌─────────────────────────────────────────┐
│           Management Portal             │     │             Employee Portal             │
│        management.yourdomain.in         │     │         employee.yourdomain.in          │
│   (HR, Admin, Dept HOD, Supervisors,    │     │      (Plant Employees / Candidates)     │
│             Evaluators)                 │     │                                         │
└────────────────────┬────────────────────┘     └────────────────────┬────────────────────┘
                     │                                               │
                     │                 Shared HTTPS / API            │
                     └───────────────────────┬───────────────────────┘
                                             │
                        ┌────────────────────▼────────────────────┐
                        │      Authoritative Backend & RBAC       │
                        │               (server.js)               │
                        ├─────────────────────────────────────────┤
                        │ • Session Lifecycle (HttpOnly Cookies)  │
                        │ • Role-Based Scoping & IDOR Prevention  │
                        │ • Server-Side Exam Scoring & Validation │
                        │ • Dynamic Security Audit Logging        │
                        └────────────────────┬────────────────────┘
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     ▼                                               ▼
     ┌───────────────────────────────┐               ┌───────────────────────────────┐
     │   Authoritative File Stores   │               │   Cloud KV / Upstash Redis    │
     │ • custom_employees.json       │               │ • yokohama_records            │
     │ • custom_questions.json       │  ◄─────────►  │ • yokohama_employees          │
     │ • assessment_records.json     │   (Bi-sync)   │ • yokohama_questions          │
     │ • ojt_evaluations.json        │               │ • active_sessions             │
     └───────────────────────────────┘               └───────────────────────────────┘
```

---

## 2. Portal Responsibilities & Role Isolation

| Portal | Roles Permitted | Accessible Capabilities | Strict Prohibitions |
|---|---|---|---|
| **Management Portal** | Admin, HR, Department HOD, Section Supervisor, Skill Evaluator | • Company-wide analytics & stats<br>• Question Bank authoring & syncing<br>• Section & Department candidate tracking<br>• Practical skill (OJT) matrix evaluation<br>• Excel & CSV report generation<br>• Exam scheduling & administrative reset | • Employees are blocked from accessing management views.<br>• HODs can only view their own assigned department.<br>• Section Supervisors can only view their assigned QA section. |
| **Employee Portal** | Plant Employees / Candidates | • Individual Employee profile & ILUO level badge<br>• Assigned MCQ Knowledge Test execution<br>• 45-minute timed exam runner with anti-cheat monitoring<br>• Authoritative instant scoring & category breakdown<br>• Milestone qualification tracking (I → L → U → O) | • Zero access to management dashboards.<br>• Zero access to employee directory.<br>• Cannot view other employees' records (IDOR protection).<br>• Cannot modify finalized submissions. |

---

## 3. Local Development

To run the unified server locally (which serves both portals simultaneously):

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite (all 43 tests including security gates)
npm test

# 3. Start local development server
npm start
```

### Accessing Local Portals:
- **Management Portal:** `http://localhost:5000/` or `http://localhost:5000/management`
- **Employee Portal:** `http://localhost:5000/employee`

---

## 4. Environment Variables Reference

Configure these environment variables in your local `.env` and in your Vercel project settings. **Never commit real credentials to Git.**

| Variable | Required in Production | Description | Example Placeholder |
|---|---|---|---|
| `APP_TARGET` | Optional (per project) | Enforces default root `/` behavior (`management` or `employee`) | `management` / `employee` |
| `ALLOWED_ORIGINS` | Recommended | Comma-separated trusted origins for CORS & CSRF | `https://management.yourdomain.in,https://employee.yourdomain.in` |
| `MANAGEMENT_PORTAL_URL` | Optional | Explicit URL of Management Portal | `https://management.yourdomain.in` |
| `EMPLOYEE_PORTAL_URL` | Optional | Explicit URL of Employee Portal | `https://employee.yourdomain.in` |
| `SESSION_SECRET` | **Required in Prod** (Min 32 chars) | Cryptographic key used to sign session cookies | `yokohama_production_secret_key_minimum_32_characters_long` |
| `UPSTASH_REDIS_REST_URL` | **Required in Prod** | Upstash Redis REST endpoint for multi-instance state sync & persistent durability | `https://your-upstash-redis-url.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | **Required in Prod** | Upstash Redis REST token | `your_upstash_redis_rest_token_here` |
| `SMTP_HOST` | Required for OTP | SMTP hostname for HR login OTP dispatch | `smtp.gmail.com` |
| `SMTP_PORT` | Required for OTP | SMTP port (465 SSL or 587 TLS) | `465` |
| `SMTP_SECURE` | Required for OTP | SSL socket flag | `true` |
| `SMTP_USER` | Required for OTP | Authorized HR Gmail username | `authorized-hr@gmail.com` |
| `SMTP_PASS` | Required for OTP | Gmail 16-character App Password | `xxxx xxxx xxxx xxxx` |
| `ADMIN_EMAIL` | Required for OTP | Authorized HR recipient email for OTP verification | `authorized-hr@gmail.com` |
| `ADMIN_USERNAME` | Required | HR/Admin login username | `admin` |
| `ADMIN_PASSWORD` | Required | HR/Admin login password | `admin_strong_password_here` |

---

## 5. Security & Authentication Model

### Insecure Fallback Removal & First-Time Setup
- Universal default passwords (`1234`, `0000`, `empNo`) are strictly rejected with HTTP `401 Unauthorized`.
- Uninitialized accounts trigger a first-time password setup workflow requiring verification of the employee's registered Date of Joining (DOJ, `YYYY-MM-DD`).
- Employee passwords are cryptographically hashed using Node.js `crypto.scryptSync` with unique cryptographic salts (`scrypt:salt:hash`).
- Real passwords and personal identifiers are sanitized from server audit logs.

### Immutable Data Stores & Upstash Redis Single Source of Truth
- On Vercel and in production environments, JSON files (`custom_employees.json`, `assessment_records.json`, `ojt_evaluations.json`) are treated strictly as **immutable read-only seed data**.
- Upstash Redis serves as the authoritative production datastore.
- Production storage write failures throw explicit errors and fail safely instead of silently swallowing errors.
- Intentional dataset resets record an initialization sentinel (`__initialized: true` in Redis and `_isExplicitlyCleared: true` in memory), preventing empty datasets from resurrecting legacy seed data.
- Atomic mutex locking (`acquireEntityLock`) and optimistic concurrency versioning (`version`, `updatedAt`) guard against race condition overwrites on concurrent submissions and evaluations.

---

## 6. Vercel Independent Project Deployment

You can deploy both websites as two independent Vercel projects from this single repository.

### Project 1: Yokohama Management Portal
1. Go to [Vercel Dashboard](https://vercel.com/dashboard) and click **Add New... → Project**.
2. Import the `yokohama-iluo-portal` repository.
3. Configure Project Settings:
   - **Project Name:** `yokohama-iluo-management` (or keep existing `yokohama-iluo-portal`)
   - **Framework Preset:** `Other`
   - **Root Directory:** `./`
4. Set Environment Variables:
   - `APP_TARGET`: `management`
   - `SESSION_SECRET`: *[your 32+ char secret]*
   - `ALLOWED_ORIGINS`: `https://management.yourdomain.in,https://employee.yourdomain.in`
   - `UPSTASH_REDIS_REST_URL`: *[Upstash Redis URL]*
   - `UPSTASH_REDIS_REST_TOKEN`: *[Upstash Redis Token]*
   - `SMTP_USER`, `SMTP_PASS`, `ADMIN_EMAIL`, etc.
5. Click **Deploy**.
6. Under **Settings → Domains**, assign your custom domain: `management.yourdomain.in`.

---

### Project 2: Yokohama Employee Portal
1. Go to [Vercel Dashboard](https://vercel.com/dashboard) and click **Add New... → Project**.
2. Import the same `yokohama-iluo-portal` repository.
3. Configure Project Settings:
   - **Project Name:** `yokohama-iluo-employee`
   - **Framework Preset:** `Other`
   - **Root Directory:** `./`
4. Set Environment Variables:
   - `APP_TARGET`: `employee`
   - `SESSION_SECRET`: *[same SESSION_SECRET as Project 1]*
   - `ALLOWED_ORIGINS`: `https://management.yourdomain.in,https://employee.yourdomain.in`
   - `UPSTASH_REDIS_REST_URL`: *[same Upstash Redis URL]*
   - `UPSTASH_REDIS_REST_TOKEN`: *[same Upstash Redis Token]*
5. Click **Deploy**.
6. Under **Settings → Domains**, assign your custom domain: `employee.yourdomain.in`.

---

## 7. Verification and Automated Test Suite

Run the complete regression test runner before any deployment:

```bash
# Run complete test suite (48 automated tests across 6 suites)
npm test
```

### Verified Test Suites:
- `tests/gate.test.js`: 14/14 passed (SESSION_SECRET fail-fast, zero-credential client scan, zero correctAnswer leak, RBAC, IDOR, audit logs, cookie security)
- `tests/two_portals.test.js`: 15/15 passed (management isolation, employee isolation, default-password rejection, DOJ verification, empty reset resilience, Redis fail-safe, concurrent write locking)
- `tests/auth.test.js`: 7/7 passed (admin, evaluator, section head, HOD, and employee login)
- `tests/exam.test.js`: 3/3 passed (exam start sanitization, server-side scoring, conflict prevention)
- `tests/security.test.js`: 5/5 passed (static asset allowlist, answer key sanitization, CSRF protection, OTP rate limiting)
- `tests/destructive.test.js`: 4/4 passed (reset-all confirmation phrase validation, audit integrity)

---

## 8. Rollback Strategy

If an unexpected production issue occurs:

1. **Instant Vercel Rollback:**
   - In the Vercel Dashboard for either project, navigate to the **Deployments** tab.
   - Locate the previous stable deployment (e.g. commit `2e67fd2`).
   - Click the three dots (`...`) and select **Promote to Production**. Instant switch takes under 5 seconds.
2. **Git Rollback:**
   ```bash
   git checkout main
   git revert HEAD
   git push origin main
   ```
3. **Data Integrity:**
   - Existing records are stored in `assessment_records.json` and mirrored in Upstash Redis.
   - A verified pristine backup is preserved at `assessment_records_backup_236.json`.
   - Seed data is immutable and protected from destructive resets via memory/Redis sentinels.
