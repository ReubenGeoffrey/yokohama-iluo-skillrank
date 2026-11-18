# Canonical Glossary & Taxonomy

**Project:** ATC Tires (Yokohama Group) ILUO Skill Assessment & Analytics Portal  
**Document Version:** 1.1.0  
**Date:** 2026-11-11  

This glossary establishes the canonical terminology, identifiers, and taxonomy to be used uniformly across the user interface, database schemas, API contracts, and exported reports (`ATC/T/FOR/HR/87D`).

---

## 1. Skill Levels (ILUO Matrix)

| Level Code | Canonical Name | Target Experience Window | Assessment Type | Promotion Target |
| :---: | :--- | :--- | :--- | :---: |
| **I** | **Level I — Induction / Beginner** | Day 0 to 7 Days | Plant Induction & Safety Orientation | Eligible for L |
| **L** | **Level L — Learner** | 7 Days to 90 Days | 20 MCQ Questions (45 Mins) + OJT Form | L → U |
| **U** | **Level U — Executor** | 3 Months to 2 Years | 30 MCQ Questions (45 Mins) + OJT Form | U → O |
| **O** | **Level O — Expert** | 2 Years and Above | 40 MCQ Questions (45 Mins) + OJT Form | Master Expert |

---

## 2. Departments

| Dept Code | Canonical Name | Display Name | Assigned Roles |
| :---: | :--- | :--- | :--- |
| **QC** | `QUALITY CONTROL` | Quality Control Department | HOD, QA Section Supervisors, Evaluators |
| **PROD** | `PRODUCTION` | Production Department | HOD, Production Supervisors, Operators |
| **HR** | `HUMAN RESOURCES` | Human Resources & Training | HR Admin, Training Coordinators |
| **SAFE** | `SAFETY` | Safety & Environment | Safety Evaluators |
| **CITPM** | `CI & TPM` | Continuous Improvement & TPM | CI & TPM Evaluators |
| **TECH** | `TECHNICAL` | Technical & Engineering | Technical Evaluators |

---

## 3. Canonical QA Sections (Quality Control — Exactly 8 Sections)

The Quality Control department is organized into exactly **8 canonical technical sections** matching the verified master question bank:

| Canonical Code | Canonical Display Name | Legacy / Employee Roster Aliases Mapped |
| :---: | :--- | :--- |
| **QA-TB** | `Tire Building QA` | `Tire building QA`, `TYRE BUILDING QA` |
| **QA-TC** | `Tire Curing QA` | `Tire curing QA`, `TYRE CURING QA` |
| **QA-FF** | `Final Finish QA` | `FINAL FINISH`, `Final Finish`, `Final Finish QA` |
| **QA-FF-RRO**| `Final Finish RRO & ALT QA`| `Final Finish ALT QA`, `Final Finish RRO QA`, `Final Finish ALT`, `Final Finish RRO` |
| **QA-PR** | `Preparatory QA` | `Preparatory`, `PREPARATORY QA` |
| **QA-ST** | `Solid Tire QA` | `Solid tire QA`, `SOLID TYRE QA` |
| **QA-WH** | `Warehouse QA` | `Ware House QA`, `WAREHOUSE QA` |
| **QA-FID** | `FID Inspector QA` | `FID Inspector`, `FID QA`, `Data Entry QA` |

---

## 4. Canonical Production Sections (Production — Exactly 25 Sections)

The Production department is organized into exactly **25 manufacturing sections**:

| Section Code | Canonical Display Name | Section Code | Canonical Display Name |
| :---: | :--- | :---: | :--- |
| **PR-MIX** | `Mixing` | **PR-BIAS1** | `Bias Cutting 1` |
| **PR-4ROLL**| `4 Roll Calender` | **PR-BIAS2** | `Bias Cutting 2` |
| **PR-3ROLL**| `3 Roll Calender P2` | **PR-BIAS4** | `Bias Cutting 4` |
| **PR-EXT** | `Extruder` | **PR-BIAS5** | `Bias Cutting 5` |
| **PR-BEAD** | `Bead Winding` | **PR-AUTOB** | `Auto Bias Cutter` |
| **PR-STEL** | `Steelastic` | **PR-SLIT** | `Slitting` |
| **PR-TB1** | `Tyre Building P1` | **PR-LINE** | `Liner Dressing` |
| **PR-TB2** | `Tyre Building P2` | **PR-SALV** | `Salvage` |
| **PR-TB3** | `Tyre Building P3` | **PR-RADM** | `Radial Marangoni` |
| **PR-BB1** | `Band Building P1` | **PR-BIASM** | `Bias Marangoni & Bestry` |
| **PR-BB2** | `Band Building P2` | **PR-YAN** | `Yanthai` |
| **PR-BB3** | `Band Building P3` | **PR-ST** | `Solid Tyre Production` |
| **PR-TC** | `Tyre Curing Production` | | |

**Reconciled Plant Total:** 8 QA Sections + 25 Production Sections = **Exactly 33 Sections Total**.

---

## 5. User Roles & Access Rights

| Role Identifier | Role Title | Portal Interface | Read Scope | Write Scope |
| :--- | :--- | :--- | :--- | :--- |
| `hr_admin` | HR Administrator | Management Portal | Global (All Sections & Depts) | Full CRUD (Employees, Questions, Scheduling, Resets) |
| `dept_hod` | Department HOD | Management Portal | Assigned Department | View department analytics & candidate progress |
| `section_head`| Section Supervisor | Management Portal | Assigned Section | View section candidates, download reports |
| `evaluator` | Practical Evaluator | Management Portal | Practical Evaluation Form | Score practical OJT checkpoints |
| `employee` | Shop-Floor Employee | Employee Portal | Self Profile & Exam Only | Self-service password setup, submit exam responses |
