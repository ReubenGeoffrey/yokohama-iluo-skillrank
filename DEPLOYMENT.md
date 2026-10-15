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
| `SESSION_SECRET` | **Required** (Min 32 chars) | Cryptographic key used to sign session cookies | `yokohama_production_secret_key_minimum_32_characters_long` |
| `UPSTASH_REDIS_REST_URL` | Recommended | Upstash Redis REST endpoint for multi-instance state sync | `https://your-upstash-redis-url.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended | Upstash Redis REST token | `your_upstash_redis_rest_token_here` |
| `SMTP_HOST` | Required for OTP | SMTP hostname for HR login OTP dispatch | `smtp.gmail.com` |
| `SMTP_PORT` | Required for OTP | SMTP port (465 SSL or 587 TLS) | `465` |
| `SMTP_SECURE` | Required for OTP | SSL socket flag | `true` |
| `SMTP_USER` | Required for OTP | Authorized HR Gmail username | `authorized-hr@gmail.com` |
| `SMTP_PASS` | Required for OTP | Gmail 16-character App Password | `xxxx xxxx xxxx xxxx` |
| `ADMIN_EMAIL` | Required for OTP | Authorized HR recipient email for OTP verification | `authorized-hr@gmail.com` |
| `ADMIN_USERNAME` | Required | HR/Admin login username | `admin` |
| `ADMIN_PASSWORD` | Required | HR/Admin login password | `admin_strong_password_here` |

---

## 5. Vercel Independent Project Deployment

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
   - `UPSTASH_REDIS_REST_URL`: *[same Redis URL]*
   - `UPSTASH_REDIS_REST_TOKEN`: *[same Redis Token]*
5. Click **Deploy**.
6. Under **Settings → Domains**, assign your custom domain: `employee.yourdomain.in`.

---

## 6. Verification and Smoke Testing

Run the automated test runner before and after any deployment:

```bash
# Run unit, integration, and security gate tests
npm test
```

### Manual Smoke-Test Checklist:
- [ ] Open `https://management.yourdomain.in`:
  - Verify that landing displays **Department**, **HR Login**, **Section Login**, and **Skill Assessment Login**.
  - Verify that employee link directs to `employee.yourdomain.in`.
  - Sign in with HR credentials and verify Control Center loads with live company stats.
- [ ] Open `https://employee.yourdomain.in`:
  - Verify that clean Employee Sign In screen loads with no management links or forms.
  - Sign in as candidate (e.g. `900262` / `1234`).
  - Verify Employee profile, ILUO level badge (`U`), and assigned knowledge exam load.
  - Start assessment, verify timer countdown, question pagination, and submit.
  - Verify instant category marks breakdown (Safety, Quality, Process, CI & TPM).
  - Click Sign Out and verify session termination.

---

## 7. Rollback Strategy

If an unexpected production issue occurs:

1. **Instant Vercel Rollback:**
   - In the Vercel Dashboard for either project, navigate to the **Deployments** tab.
   - Locate the previous stable deployment.
   - Click the three dots (`...`) and select **Promote to Production**. Instant switch takes under 5 seconds.
2. **Git Rollback:**
   ```bash
   git checkout main
   git revert <commit-hash>
   git push origin main
   ```
3. **Data Integrity:**
   - Existing records are stored in `assessment_records.json` and mirrored in Upstash Redis.
   - A verified pristine backup is preserved at `assessment_records_backup_236.json`.
   - To restore the base demo records if needed:
     ```bash
     curl -X POST https://your-management-url/api/records/restore-demo -H "Authorization: Bearer <ADMIN_TOKEN>"
     ```
