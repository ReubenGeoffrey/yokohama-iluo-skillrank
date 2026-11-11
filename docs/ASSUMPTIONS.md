# Architectural & Business Rule Assumptions

**Project:** ATC Tires (Yokohama Group) ILUO Skill Assessment & Analytics Portal  
**Document Version:** 1.1.0  
**Date:** 2026-11-11  

This document records all baseline assumptions, operational definitions, and business logic reconciliations formulated during the Phase 1 audit and refined following stakeholder review.

---

## 1. Exam Eligibility & Experience Rules (Issue B1)

### Identified Gap
The legacy public matrix currently displays:
- **Level L (Learner):** 7 to 90 days of experience.
- **Level U (Executor):** 3 months to 2 years of experience.
- **Level O (Expert):** > 4 years of experience.

Employees with experience between 2 years and 4 years (24 to 48 months) fell into an unmapped dead zone where no advancement rule applied.

### Approved Architecture & Baseline Rule
1. **Model:** Eligibility is calculated purely from the employee's `currentLevel` plus **configurable minimum service months per transition**, with zero overlapping ranges.
2. **Transition Matrix Configuration (`eligibility_config`):**
   - **`I → L` (Induction to Learner):** Minimum 7 days (0.25 months), Maximum 90 days (3.0 months).
   - **`L → U` (Learner to Executor):** Minimum 3 months (0.25 years), Maximum 24 months (2.0 years).
   - **`U → O` (Executor to Expert):** Default Minimum **24 months (2.0 years)** `[PENDING HR CONFIRMATION]`.
3. **Execution Rule:**
   - Calculation is performed by a pure function: `isEligibleForAssessment(emp, targetLevel, config)`.
   - Experience is computed in completed months from `doj` (Date of Joining) relative to the assessment date in timezone `Asia/Kolkata`.
   - No invented designations (e.g., "Senior Expert" or "expedited priority" have been removed).

---

## 2. Pass Mark Standards & Score Thresholds (Issue B2)

### Identified Policy Divergence
- `server.js` previously evaluated score as `>= 50%` (0.50).
- `app.js` UI text states `> 50%`.
- Security Settings modal default input shows `70%`.
- Excel export formula evaluates tiered thresholds: `L >= 50%, U >= 60%, O >= 75%`.
- Practical OJT threshold states `≥ 70%` (35 out of 50 marks).

### Approved Architecture & Baseline Rule
1. **Do Not Flatten:** Passing thresholds reflect intentional, tiered competence rigor per skill level.
2. **Single Config Source (`threshold_config`):**
   - **Level L Knowledge MCQ:** Default **>= 50%** (10 / 20 marks) `[PENDING HR CONFIRMATION]`.
   - **Level U Knowledge MCQ:** Default **>= 60%** (18 / 30 marks) `[PENDING HR CONFIRMATION]`.
   - **Level O Knowledge MCQ:** Default **>= 75%** (30 / 40 marks) `[PENDING HR CONFIRMATION]`.
   - **Admin Settings Default Fallback:** Default **70%** `[PENDING HR CONFIRMATION]`.
   - **Practical OJT Passing Threshold:** Default **>= 70%** (35 / 50 marks) AND strict adherence to Work Instructions (WI) `[PENDING HR CONFIRMATION]`.
3. **Evaluation Logic:** UI badges, server-side grading, and reporting modules read directly from this single authoritative configuration.

---

## 3. Production Staff Assessment & Foundational Modules (Issue B8)

### Identified Void
- 1,179 production employees across 25 production sections are rostered in the employee directory.
- All 720 existing questions in `custom_questions.json` belong exclusively to 8 Quality Control sections. Zero questions exist for Production.

### Approved Architecture & Baseline Rule
1. **No Level Promotion via Foundation Questions:** Production employees **cannot** advance their ILUO skill level using generic foundational questions.
2. **Dedicated Manufacturing Foundation Module:**
   - A standalone, non-promotional module covering plant fundamentals: Safety (PPE, 5S, Fire Safety), CI & TPM (Kaizen, 1S-5S), and Basic Quality Awareness.
   - Successful completion is recorded, badged, and reported as **Compliance / Induction Training**, but the candidate's ILUO skill level remains unchanged.
3. **Section Exam Locking:**
   - Technical ILUO skill advancement exams for any section remain **strictly locked** until an approved, section-specific question bank is uploaded by HR/HOD via the bulk import facility.

---

## 4. Database Architecture, Persistence & Production Fail-Closed

### Current Architecture vs Target
- Currently operates on Vercel with Upstash Redis KV and local JSON files.
- No Supabase or PostgreSQL instance is currently linked in active environment variables.

### Approved Architecture & Baseline Rule
1. **Production Fail-Closed Enforcement:**
   - The Vercel serverless filesystem is ephemeral and read-only.
   - In production, the system must **fail closed**: if the authoritative cloud datastore (PostgreSQL / Upstash Redis) is unavailable or write-forbidden, write requests must return HTTP 503 (`SERVICE_UNAVAILABLE`).
   - Local JSON file fallback is strictly permitted in local development and test environments (`NODE_ENV !== 'production'`).
2. **Service-Role Key & Defense-in-Depth RLS:**
   - The Express backend server runs in a trusted serverless execution environment. It connects to PostgreSQL / Supabase using the database connection pool or Supabase service-role credentials.
   - **Row Level Security (RLS)** is configured on all tables as defense-in-depth. For client-direct queries or edge functions, Supabase JWTs with verified claims (`role: hr_admin | dept_hod | section_head | evaluator | employee`, `section: string`, `dept: string`) enforce row access policies.
3. **Data Migration Plan (Redis/JSON → Postgres):**
   - Migration pipeline includes: schema validation, dry-run export/import script, dual-write verification period, row count verification, and documented rollback.

---

## 5. Canonical Naming & Taxonomy Reconciled (Issues B4, B5, B6, B7)

### Approved Section Count
- Total operational manufacturing sections: **33 Sections** (exactly **8 QA sections** + **25 Production sections**).
- Legacy employee section aliases (e.g., `FINAL FINISH`, `Final Finish ALT QA`, `Final Finish RRO QA`, `Data Entry QA`, `FID Inspector QA`) are normalized to the 8 canonical QA section codes in `docs/GLOSSARY.md`.
- Plant standard spelling **"Tire"** is adopted uniformly across all modules to match official form `ATC/T/FOR/HR/87D`.
