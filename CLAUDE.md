# PSEMS Backend — Context for Claude Code

## What this is
Backend for PSEMS (Project Scoring, Evaluation & Management System) — a CO3554 university project (5 credits) that must launch as a **real single-department faculty pilot by end of September 2026**. Full spec is in `docs/` (read `PSEMS_Comprehensive_Specification_v2.docx` for full detail — roles, 12-step CPI lifecycle, DB schema, ML endpoints; `PSEMS_Delivery_Roadmap.md` for the week-by-week build plan).

## Repo layout reality
This is one of **four separate repos** (polyrepo, not monorepo):
- `psems-backend` (this repo) — Node.js 20 / Express / TypeScript / Prisma / PostgreSQL+pgvector / Redis
- `psems-frontend` — React 18 / TypeScript / Vite / Tailwind
- `psems-ml-service` — Python 3.12 / FastAPI / scikit-learn / sentence-transformers
- `psems-infra` — docker-compose.yml for local Postgres+pgvector and Redis (shared by backend and ml-service)

Architecture is a **modular monolith**, not microservices: this backend is ONE deployable service with internal modules (auth, students, courses, groups, ideas, selection, allocation, evaluations, scoring, headjudge, scheduling, marks, analytics, notifications, files). Only the ML layer is a separate service, deliberately decoupled so the platform works even if ML is down.

Before touching this repo, bring up shared infra from the sibling `psems-infra` repo: `docker compose up -d` (Postgres+pgvector on 5432, Redis on 6379). `.env.example` in this repo has the connection strings.

## Timeline reality — read before making architectural decisions
Starting from zero on 2026-07-05, solo developer, ~12.5 weeks to a real pilot launch (not just a demo). The original spec's Gantt chart assumed 8 months — we've compressed to single-department pilot scope (matches the spec's own "Phase 1: single department" future roadmap) rather than cutting features. Non-negotiables regardless of time pressure: evaluator score isolation before Head Judge review, forced first-login password change + bcrypt + short-lived JWTs, RBAC enforced at both middleware AND service layer, audit logging on all writes, anonymized historical data before ML use. See the roadmap doc for the exact cut-list priority if something has to give.

## How the developer wants to work
The person building this explicitly wants to **learn the stack hands-on** (Prisma, pgvector, RBAC/JWT patterns, this is mostly new to them) — not just receive finished code. Default to explaining reasoning and letting them drive implementation, rather than silently generating large chunks of code. Check in on what actually got built at the end of each week against the roadmap table rather than assuming the plan survived contact with reality.

## Current phase
Week 3 COMPLETE as of 2026-07-10 (Week 1 = `07159cd`, Week 2 = `b732a26`; Week 3 not yet committed). Shipped this week: CPI creation (type/participation-mode/dept/year), 10-phase timeline engine (replace-all in a transaction, completeness + chronological-ordering validation), `requirePhase()` phase-gating middleware (time-window gate, distinct from RBAC and CPI-ownership), supervisor addition with automatic mode determination (inviting the first supervisor flips mode→SUPERVISOR_LED; explicit `finalize-coordinator-managed` skip path→COORDINATOR_MANAGED; lecturer accept/decline), evaluator + Head Judge assignment (one HJ per CPI, must come from evaluator pool, both modes). Also added `POST /users/:id/assign-coordinator` (System Admin promotes approved lecturer) since coordinators had to come from somewhere, and a shared `assertRole()` helper (refactored the two Week 2 inline admin checks onto it). Key design decision: **CPI-scoped roles live in the `cpi_supervisors`/`cpi_evaluators` junction tables, NOT on `User.role`** — a lecturer's account role stays LECTURER; whether they can act as supervisor/evaluator/HJ for a given CPI is answered by the junctions. Coordinator CPI-scope enforced in service layer (`loadOwnedCpi`: 404 non-existent, 403 not-owned). Seed now includes coordinator@psems.dev / Coord#Pilot2026 and lecturer1&2@psems.dev / Lect#Pilot2026. 14 tests green (4 suites), typecheck+lint clean. **Note:** re-running the seed does NOT reset existing users' passwords (upsert with empty update) — `student1`'s password is whatever it was last changed to, not necessarily the seed temp password. Next up: Week 4 — group formation (invite/accept/lock), idea posting with mode-specific visibility rules, coordinator approve/reject.

### Prior weeks (condensed)
Week 1: TS/Express/Prisma scaffold, JWT (15m access + 7d rotating refresh in Redis)+bcrypt(12) auth, forced first-login password change, RBAC middleware (`requireAuth`/`requireRole`), CI against real Postgres+Redis. Week 2: student bulk provisioning (CSV→CSPRNG temp pw→BullMQ credential emails, `student_provisioning_log`), lecturer self-registration + admin approval (enumeration-safe login gate), audit log middleware on all writes (SHA-256 payload hash, never stored). Deviations: BullMQ not Bull, Prisma v6 (v7 dropped `datasource url` syntax), ioredis pinned 5.10.1 to match BullMQ, added `LECTURER` base role. SMTP env-driven w/ dev jsonTransport fallback — real creds needed before pilot.
