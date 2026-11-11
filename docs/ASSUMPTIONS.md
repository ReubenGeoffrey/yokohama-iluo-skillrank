# Architectural & Business Rule Assumptions

**Project:** ATC Tires (Yokohama Group) ILUO Skill Assessment & Analytics Portal  
**Document Version:** 1.0.0  
**Date:** 2026-11-11  

This document records all baseline assumptions, operational definitions, and business logic reconciliations formulated during the Phase 1 audit. Any changes to plant HR policies should be updated here.

---

## 1. Exam Eligibility & Experience Rules (Issue B1)

### Identified Gap
The public matrix currently states:
- **Level L (Learner):** 7 to 90 days of experience.
- **Level U (Executor):** 3 months to 2 years of experience.
- **Level O (Expert):** > 4 years of experience.

Employees with **2 years to 4 years of experience (24 to 48 months)** fall into an unmapped dead zone where no advancement rule applies.

### Baseline Assumption
1. **Progression Path:**
   - **I → L (Induction to Learner):** Eligible between 7 days and 90 days.
   - **L → U (Learner to Executor):** Eligible between 3 months and 24 months (2 years).
   - **U → O (Executor to Expert):** Eligible from **24 months (2 years) and above**. Candidates with 4+ years are categorized as Senior Expert candidates with expedited scheduling priority.
2. **Pure Function Rule:** Experience is calculated in completed months from `doj` (Date of Joining) relative to the assessment date in timezone `Asia/Kolkata`.

---

## 2. Pass Mark Standards (Issue B2)

### Identified Discrepancy
- `server.js` evaluates score as `>= 50%` (0.50).
- `app.js` UI text states `> 50%`.
- Security Settings modal default input shows `70%`.
- Excel export formula evaluates `L >= 50%, U >= 60%, O >= 75%`.
- Practical OJT threshold states `≥ 70%` (35 out of 50 marks).

### Baseline Assumption
1. **MCQ Knowledge Pass Rule:**
   - Standard minimum pass threshold is **>= 50%** (inclusive).
   - For Level L (20 questions): Passing mark is **10 / 20**.
   - For Level U (30 questions): Passing mark is **15 / 30**.
   - For Level O (40 questions): Passing mark is **20 / 40**.
2. **Practical OJT Pass Rule:**
   - Evaluated out of 50 total possible marks across 10 checkpoints (1-5 scale).
   - Passing threshold is strictly **>= 70% (35 / 50 marks)** AND adherence to Work Instructions (WI).
3. **Dual Qualification Status:**
   - **Both Passed:** Candidate is recommended for target level advancement.
   - **MCQ Failed, OJT Qualified:** MCQ Retest required.
   - **MCQ Passed, OJT Failed:** Practical Checkpoint Refresher required.
   - **Both Failed:** Full Retraining and Retest required.

---

## 3. Database Architecture & Supabase / PostgreSQL (Phase 3)

### Current Architecture
- The application currently operates as an Express serverless monolith on Vercel backed by:
  - Local JSON files (`custom_employees.json`, `custom_questions.json`, `assessment_records.json`, `ojt_evaluations.json`, `audit_logs.json`).
  - Upstash Redis REST KV (`yokohama_records`, `yokohama_employees`, `yokohama_question_bank`, `yokohama_ojt_evaluations`, `yokohama_audit_logs`, `yokohama_settings`, `exam:<empNo>`).
- No active Supabase or PostgreSQL database instance is currently configured in the environment variables.

### Baseline Assumption
1. Full PostgreSQL / Supabase schemas, tables, constraints, foreign keys, triggers, and Row Level Security (RLS) policies will be authored as versioned SQL migration scripts in `migrations/` and documented in `docs/DB_SCHEMA.md`.
2. A typed data-access adapter layer will be implemented that supports both PostgreSQL/Supabase (when connection parameters `DATABASE_URL` / `SUPABASE_URL` are set) and Upstash Redis / local JSON (for local testing and offline execution), preventing deployment disruption.

---

## 4. Production Staff Question Bank (Issue B8)

### Identified Void
- 1,179 production employees across 25 production sections are rostered in the employee directory.
- All 720 existing questions in `custom_questions.json` are tagged to 8 Quality Control sections. No production questions exist.

### Baseline Assumption
1. Until production-specific technical question banks are uploaded via the Excel/Word bulk import tool, production employees assigned for assessment will receive foundational plant-wide questions covering:
   - **Safety (PPE, Hazard identification, 5S, Fire safety)**
   - **CI & TPM (Continuous Improvement, Kaizen, Autonomous Maintenance)**
   - **General Quality & Defect Identification**
2. The bulk import facility (Phase 6) will enable HR and Production HODs to upload section-specific question banks for all 25 production sections.

---

## 5. Canonical Naming & Glossary (Issues B4, B5, B6, B7)

### Baseline Assumption
1. **Spelling Standard:** We adopt the standardized corporate plant spelling **"Tire"** for consistency with the official template `ATC/T/FOR/HR/87D` (e.g., "Tire Building QA", "Solid Tire QA", "Tire Curing QA").
2. **Section Normalization:** All duplicate and case-variant section names will map to canonical section IDs via the mapping table documented in `docs/GLOSSARY.md`.
