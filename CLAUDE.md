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
Week 1 COMPLETE as of 2026-07-06 (Prisma schema v1, JWT+bcrypt auth, forced first-login password change, RBAC middleware skeleton, Jest+Supertest acceptance test, CI workflow against real Postgres+Redis). Typecheck verified clean. **Not yet committed to git** — all Week 1 files are untracked on the `dev` branch; commit before starting new work. Next up: Week 2 — student bulk provisioning (CSV import, temp password generation, Bull-queued email dispatch), lecturer self-registration + admin approval, audit log middleware.
