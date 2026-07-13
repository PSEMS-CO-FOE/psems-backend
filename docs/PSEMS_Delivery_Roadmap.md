# PSEMS Delivery Roadmap
**From zero to a real single-department pilot launch — July 5 to September 30, 2026 (solo build)**

---

## Progress Log

**Corrected 2026-07-13** — a prior update to this log (2026-07-06) was stale; the developer had been working ahead in Claude Code without syncing back here. `psems-backend`'s own `CLAUDE.md` is being kept meticulously current after every week and is the authoritative source for backend detail — this log now defers to it and just tracks cross-repo status.

**Backend: Weeks 1–5 committed, Week 6 code complete but uncommitted, as of 2026-07-13.**
- Week 1 (`07159cd`): Express/Prisma/TS scaffold, JWT auth (15m access + 7d rotating refresh in Redis) + bcrypt(12), forced first-login password change, RBAC middleware skeleton, CI against real Postgres+Redis.
- Week 2 (`b732a26`): student bulk provisioning (CSV → temp password → BullMQ credential emails, provisioning log), lecturer self-registration + admin approval, audit logging (SHA-256 payload hash) on all writes.
- Week 3 (`d13ee4c`): CPI creation + full 10-phase timeline engine, phase-gating middleware, supervisor addition with automatic Supervisor-Led/Coordinator-Managed mode determination, evaluator + Head Judge assignment.
- Week 4 (`7f9653b`): group formation (invite/accept, one accepted group per CPI, phase-locked), idea posting with mode-specific visibility rules enforced at query time (not stored per-idea), coordinator approve/reject for student ideas.
- Week 5 (`9e5f7b2`): Expression of Interest + Mutual Confirmation — ranked supervisor preferences, "willing to supervise," conflict resolution, both CPI modes.
- Week 6 (uncommitted): allocation finalization + coordinator override (Step 7), fully configurable evaluation stage/rubric config with weight validation (Step 8), proposal file upload with a pluggable local-disk/Supabase storage backend (Step 9). 28 tests green across 7 suites per the backend's own record; I independently re-verified `tsc --noEmit` clean on the current uncommitted state.

**Frontend and ML service: still untouched — 6 weeks in, this is now the single biggest risk to the plan**, not a minor process note anymore. The Week 1.5 "frontend detour" recommended earlier didn't happen; all six weeks went into backend. There is currently no way for anyone (including you, for your own testing/demo purposes) to click through any of this — every module so far is API-only, verified via automated tests, not a browser.

**Correction to a prior finding:** the "git lock file" flagged on 2026-07-06 as a likely blocker turned out to be a false alarm — it was this Cowork session's own sandbox failing to touch files inside your OneDrive-synced `.git` folder, not a real problem in your actual WSL git. Proof: Weeks 1–5 are committed fine. Disregard that earlier advice.

---

## 1. The honest reality check

Your submitted proposal's own Gantt chart budgets **8 months** (April–November 2026) for this scope, built with an assumption of steady progress since April. You're starting the actual build today, July 5, with **~12.5 weeks** to a **real pilot launch** — not just a graded demo. That's roughly a third of the originally planned time, solo.

The full spec is not fake scope — every piece (7 roles, 12-step lifecycle, dual CPI modes, 24-table schema, 7 ML features, notification system, defense-in-depth security) is justified and buildable. But "all of it, production-hardened, faculty-wide, by Sept 30, alone" is not realistic. The fix isn't cutting the vision — it's **sequencing and narrowing the pilot's blast radius**, which is exactly what your own report already recommends in Section 11.2: *"Phase 1 (Immediate): Single department."* We lean into that.

**Core strategy:**
- Pilot launches for **one department, one CPI** (e.g., one Data Management Project cohort) — not faculty-wide. This is not a scope cut from your report, it's literally your report's own Phase 1.
- **Security and data-handling basics are built in from Week 1**, not bolted on later — this is real student PII and real passwords from day one, non-negotiable.
- **Every week ships a working vertical slice** (backend + minimal UI for that module) — never "backend done, frontend pending." *(Note: this has drifted 6 weeks off-plan — see Progress Log. Needs a deliberate correction, not just a resolution to try harder — see Section 6.)*
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

## 3. Week-by-week plan — status as of 2026-07-13

| Week | Dates | Build | Status |
|---|---|---|---|
| 1 | Jul 6–12 | Auth, forced password change, RBAC skeleton, Prisma v1, CI | ✅ committed (`07159cd`) |
| 2 | Jul 13–19 | Student provisioning, lecturer approval, audit logging | ✅ committed (`b732a26`) |
| 3 | Jul 20–26 | CPI creation, timeline engine, phase gating, mode determination | ✅ committed (`d13ee4c`) |
| 4 | — | Group formation, idea posting + visibility rules | ✅ committed (`7f9653b`) |
| 5 | — | EOI + Mutual Confirmation | ✅ committed (`9e5f7b2`) |
| 6 | — | Allocation finalize/override, evaluation config, proposal upload | ✅ code complete, **not yet committed** |
| 7 | next | Scheduling, evaluation execution (evaluator isolation), Head Judge review | Not started |
| 8 | next | Mark aggregation, publishing, notifications | Not started |
| — | ongoing gap | **Frontend: nothing built** — no login screen, no dashboard, no way to demo any of Weeks 1–6 in a browser | Not started, 6 weeks behind |
| 9–11 | after backend core | ML service: 7 endpoints (idea suggestion + plagiarism warning → success predictor + similar projects → topic clustering + supervisor match + grade analytics) | Not started; still needs historical faculty data requested |
| 12 | — | Integration testing, security hardening, real pilot data setup | Not started |
| 13 | — | Deploy, go-live | Not started |

Backend pace has actually been faster than the original weekly cadence implied (5 weeks of backend scope in what reads as a tight week of actual work, based on the dates in play) — that's good news for the overall deadline, but only if the frontend gap gets closed deliberately rather than deferred again.

---

## 4. Non-negotiables (do not cut these even under time pressure)

- **Evaluator score isolation before Head Judge review** — a broken version of this undermines the entire academic-integrity pitch of the project. (Week 7, next.)
- **Forced first-login password change + bcrypt + JWT short-lived tokens** — done (Week 1).
- **RBAC checks at both middleware and service layer** — one missed check is a data leak between groups/students, which is the exact "fairness" problem PSEMS exists to solve.
- **Audit logging on all write operations** — done (Week 2).
- **Anonymization of historical data before ML training** — non-negotiable regardless of timeline, per the spec's own privacy section. (Weeks 9–11.)

## 5. Cut list, in priority order (use only if a week actually slips)

1. Topic trend clustering visuals — ship as a simple bar chart instead of stacked bar + bubble chart combo.
2. Supervisor compatibility scoring — ship as keyword/TF-IDF overlap instead of a fully tuned SBERT profile match; upgrade post-launch.
3. Grade distribution analytics — ship 2–3 core charts (box plot, bar chart) instead of the full six-visualization set; nightly cron precompute can be on-demand compute instead for pilot scale.
4. Scheduling conflict UI polish — manual coordinator resolution is fine; don't build automated conflict-suggestion logic.
5. Never touch: auth, RBAC, evaluator isolation, mark aggregation correctness, or data privacy — these are the actual point of the system.

## 6. Immediate next steps

1. **Commit Week 6** (allocation, evaluations, files modules + schema migration) — it's sitting uncommitted right now.
2. **Stop and build the frontend before Week 7.** Not a "nice to have" detour anymore — 6 weeks of backend work is genuinely unusable/undemoable without it, and the gap only compounds if Week 7–8 get added on top uncontested. Minimum viable catch-up, in order: (a) Vite+React+TS+Tailwind scaffold, (b) login + forced-password-change screen, (c) a bare-bones Course Coordinator view to create a CPI and set the timeline (Week 3's API), (d) a student view to register/form a group and post an idea (Week 4's API). That alone would make the last month of backend work demonstrable, which matters both for your own confidence in the system and for eventually showing this to your supervisor/the pilot department.
3. Confirm the historical faculty data request has actually gone out — if not, send it now, since it's an external dependency and every week of delay pushes Weeks 9–11 back.
4. After the frontend catch-up, resume backend at Week 7 (scheduling, evaluation execution, Head Judge review).

---
*This roadmap assumes ordinary availability alongside other coursework. If you have exams or other module deadlines in this window, tell me the dates and we'll redistribute the weeks around them rather than discover the conflict in August.*
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           