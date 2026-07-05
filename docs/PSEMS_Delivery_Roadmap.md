# PSEMS Delivery Roadmap
**From zero to a real single-department pilot launch — July 5 to September 30, 2026 (solo build)**

---

## 1. The honest reality check

Your submitted proposal's own Gantt chart budgets **8 months** (April–November 2026) for this scope, built with an assumption of steady progress since April. You're starting the actual build today, July 5, with **~12.5 weeks** to a **real pilot launch** — not just a graded demo. That's roughly a third of the originally planned time, solo.

The full spec is not fake scope — every piece (7 roles, 12-step lifecycle, dual CPI modes, 24-table schema, 7 ML features, notification system, defense-in-depth security) is justified and buildable. But "all of it, production-hardened, faculty-wide, by Sept 30, alone" is not realistic. The fix isn't cutting the vision — it's **sequencing and narrowing the pilot's blast radius**, which is exactly what your own report already recommends in Section 11.2: *"Phase 1 (Immediate): Single department."* We lean into that.

**Core strategy:**
- Pilot launches for **one department, one CPI** (e.g., one Data Management Project cohort) — not faculty-wide. This is not a scope cut from your report, it's literally your report's own Phase 1.
- **Security and data-handling basics are built in from Week 1**, not bolted on later — this is real student PII and real passwords from day one, non-negotiable.
- **Every week ships a working vertical slice** (backend + minimal UI for that module) — never "backend done, frontend pending." That way at any checkpoint you have a demoable, honest picture of where things stand, not a hidden pile of frontend debt.
- **Scalability targets (2,000+ concurrent users, k6 load testing) are explicitly deferred** past Sept 30 — irrelevant for a single-CPI pilot and would burn weeks you don't have.

---

## 2. What ships for the Sept 30 pilot vs. what waits

| Ships for pilot (Phase 1) | Deferred to Phase 2 (post-launch) |
|---|---|
| Full auth + RBAC (all 7 roles) | Multi-department / multi-tenant scale |
| Student bulk provisioning + email dispatch | 2,000+ concurrent user load testing (k6) |
| Full 12-step CPI lifecycle, both modes | External competitions module, LMS sync |
| EOI + Mutual Confirmation | Evaluator bias detection ML |
| Configurable rubric evaluation + Head Judge | Peer evaluation module |
| Mark aggregation + publishing | Mobile app |
| Notifications (in-app + email) | Advanced report NLP / knowledge base |
| ML Feature 1 — Idea suggestion | — |
| ML Feature 4 — Plagiarism/similarity warning | — |
| ML Feature 2 — Success rate predictor | — |
| ML Feature 3 — Similar projects recommender | — |
| ML Feature 5 — Topic trend clustering (simplified if behind) | Elaborate cluster dashboards |
| ML Feature 6 — Supervisor compatibility (simplified if behind) | — |
| ML Feature 7 — Grade distribution analytics (core charts only) | Nightly cron precompute polish |
| Core security (JWT, bcrypt, RBAC defense-in-depth, audit log, rate limiting) | Penetration testing, formal security audit |

All 7 ML features still ship — some may launch in a simplified first version (e.g., keyword-overlap compatibility instead of a fully tuned embedding match) rather than being cut. See the cut list in Section 5 for the exact fallback order if a week runs long.

---

## 3. Week-by-week plan (vertical slices)

Each week = a working backend module **and** the minimal UI to actually use it. If a week slips, the fallback list in Section 5 tells you what to trim first — never silently skip security or evaluator-isolation logic.

| Week | Dates | Build | Demo at end of week |
|---|---|---|---|
| 0 (today) | Jul 5–6 | Confirm pilot department/CPI with your supervisor/coordinator contact. **Request historical faculty project data today** — this has external lag and gates all ML work in Weeks 9–11. | Data request sent; pilot scope confirmed in writing |
| 1 | Jul 6–12 | Repo + Docker Compose (Postgres+pgvector, Redis), Prisma schema v1 (users, students, lecturers, course_instances, cpi_timelines), JWT+bcrypt auth, forced first-login password change, RBAC middleware skeleton, CI (lint+test on push) | Login works for a seeded Admin + Student; first-login flow enforced |
| 2 | Jul 13–19 | Student bulk provisioning (CSV import → temp password gen → Bull-queued email dispatch), lecturer self-registration + admin approval, audit log middleware | Admin uploads a CSV of 20 test students → all receive credential emails |
| 3 | Jul 20–26 | CPI creation, timeline engine (10 phases), phase-gating middleware, supervisor addition step (mode determination), evaluator/Head Judge assignment | Coordinator creates a CPI, sets phase dates, adds a supervisor → mode flips to Supervisor-Led |
| 4 | Jul 27–Aug 2 | Group formation (invite/accept/lock), idea posting with mode-specific visibility rules, coordinator approve/reject (Coordinator-Managed) | Students form a group, post an idea, visibility rules verified for both modes |
| 5 | Aug 3–9 | EOI + Mutual Confirmation (ranked preferences, willing-to-supervise, accept/decline, conflict resolution) | A student group and supervisor go through full EOI → mutual accept flow |
| 6 | Aug 10–16 | Project Registration/allocation finalize + coordinator override; Evaluation Config (stages, weights, rubric criteria, evaluator assignment); proposal upload to Supabase Storage | Coordinator configures a 4-stage rubric; a group uploads a proposal PDF |
| 7 | Aug 17–23 | Scheduling (availability submission, timetable finalize); Evaluation execution (scoring interface, evaluator isolation enforced); Head Judge review (side-by-side, approve/request correction) | Two evaluators score independently, Head Judge approves, scores lock |
| 8 | Aug 24–30 | Mark aggregation engine, publishing, student mark view; notifications (in-app + email) for all key events from Section 10 of the spec | Full lifecycle dry run: CPI created → group → idea → selection → evaluation → published marks, with notification emails firing throughout |
| 9 | Aug 31–Sep 6 | ML service scaffold (FastAPI), preprocessing pipeline on the (hopefully by-now-received) historical data, SBERT embeddings into pgvector, **Feature 1 (idea suggestion) + Feature 4 (plagiarism warning)** — built together since they share the embedding index | Typing an idea shows live suggestions; submitting a near-duplicate idea triggers the tiered warning |
| 10 | Sep 7–13 | **Feature 2 (success predictor, Random Forest)** + **Feature 3 (similar projects recommender)** — reuse Week 9's pipeline and data | Idea page shows a success % and a "related past projects" panel |
| 11 | Sep 14–20 | **Feature 5 (topic clustering)**, **Feature 6 (supervisor compatibility, Supervisor-Led only)**, **Feature 7 (grade distribution analytics — core charts)** | Coordinator dashboard shows topic trend chart, grade distribution chart, and (if Supervisor-Led CPI used) a compatibility badge |
| 12 | Sep 21–27 | End-to-end integration testing across all 12 lifecycle steps, security hardening pass (Helmet, CORS lock to production origin, rate limiting, re-check RBAC on every route), bug fixing, real pilot data setup (real cohort, real CPI) | Full lifecycle runs clean with the real pilot department's actual data |
| 13 | Sep 28–30 | Buffer, deploy, go-live, watch logs closely for the first real usage | Pilot is live |

---

## 4. Non-negotiables (do not cut these even under time pressure)

- **Evaluator score isolation before Head Judge review** — a broken version of this undermines the entire academic-integrity pitch of the project.
- **Forced first-login password change + bcrypt + JWT short-lived tokens** — this touches real students' real credentials.
- **RBAC checks at both middleware and service layer** — one missed check is a data leak between groups/students, which is the exact "fairness" problem PSEMS exists to solve.
- **Audit logging on all write operations** — needed for both academic integrity and for your own debugging sanity once real users touch it.
- **Anonymization of historical data before ML training** — non-negotiable regardless of timeline, per the spec's own privacy section.

## 5. Cut list, in priority order (use only if a week actually slips)

1. Topic trend clustering visuals — ship as a simple bar chart instead of stacked bar + bubble chart combo.
2. Supervisor compatibility scoring — ship as keyword/TF-IDF overlap instead of a fully tuned SBERT profile match; upgrade post-launch.
3. Grade distribution analytics — ship 2–3 core charts (box plot, bar chart) instead of the full six-visualization set; nightly cron precompute can be on-demand compute instead for pilot scale.
4. Scheduling conflict UI polish — manual coordinator resolution is fine; don't build automated conflict-suggestion logic.
5. Never touch: auth, RBAC, evaluator isolation, mark aggregation correctness, or data privacy — these are the actual point of the system.

## 6. Immediate next steps (this week)

1. Confirm with your supervisor which specific department/CPI is the real pilot target — this determines the real student email list you'll need for provisioning testing.
2. **Send the historical project data request to the faculty/department today.** This is the single most likely external bottleneck — everything in Weeks 9–11 depends on having usable data by ~mid-August.
3. Set up the repo skeleton (I can scaffold this with you directly — monorepo with `/backend`, `/frontend`, `/ml-service`, `docker-compose.yml`).
4. Decide your evaluation/testing rhythm with me: I'd suggest a short check-in at the end of each week against the table in Section 3 — tell me what actually shipped vs. planned, and we adjust the following week rather than pretending the plan survived contact with reality.

---
*This roadmap assumes ordinary availability alongside other coursework. If you have exams or other module deadlines in this window, tell me the dates and we'll redistribute the weeks around them rather than discover the conflict in August.*
