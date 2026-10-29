# NFPL Access Control Service

Who may do what, on which customs job, and why. Strict where it matters (filed jobs, maker ≠ checker, no self-escalation), easy day to day (grants with wildcards, roles as data, delegation).

Stack: React (Vite) + Tailwind + axios · Node/Express (ES modules) · PostgreSQL (Neon) · Vitest.
Docs: [DESIGN.md](DESIGN.md) (decisions + the 14 questions) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DEMO.md](DEMO.md) (5-minute script).

## Setup

You need Node 18+ and a Postgres database. On Neon, copy the **direct (non-pooled)** connection string: the app sets `search_path` as a connection startup option, which Neon's pooler does not accept.

```bash
cd backend
cp .env.example .env          # set DATABASE_URL (and JWT_SECRET)
npm install
npm run migrate               # creates schema "nfpl" (drops and recreates it)
npm run seed                  # demo data, one command
npm run dev                   # API on :4000

cd ../frontend
npm install
npm run dev                   # UI on http://localhost:5173  (VITE_API_URL to point elsewhere)
```

| Command (in `backend/`) | What it does |
|---|---|
| `npm run seed` | Resets schema `nfpl`, loads 5 branches, 10 clients, 20 users, 312 jobs and the awkward cases below |
| `npm run seed:scale` | Same, then adds 480 users (500 total) with random grants and 200,000 jobs via batched `unnest` inserts. About 10 s on a local Postgres; allow longer on Neon |
| `npm test` | 60 Vitest tests against schema `nfpl_test` in the same database (re-seeded per file; refuses to touch `nfpl`) |

**Demo password for every seeded user: `Demo@1234`.** The login page and header have a "switch user" dropdown.

## Who is who (all emails `@nfpl.test`)

| Person (email prefix) | Access in plain terms |
|---|---|
| Anita Admin (`admin`) | Admin, all scopes: manage grants (Maker, Checker, Filer, Supervisor, BranchManager, ClientUser, Parser), `admin_fix` on unfiled jobs. **Cannot** prepare/check/file, cannot grant herself anything, cannot mint another Admin |
| Meera Maker-All (`maker.all`) | Maker for **every** client; Checker for **only Acme and Bharat** |
| Chirag Checker-Narrow (`checker.narrow`) | Checker for **Acme, Mumbai branch, imports only** (any mode) |
| Dev Dual (`both.dual`) | Maker **and** Checker for everything. Prepared `NFPL-DEMO-CONFLICT`, so cannot check it |
| Om Absent (`owner.absent`) | Maker for Acme and Bharat; responsible owner of `NFPL-DEMO-ABSENT-1..3` (on leave) |
| Carla Cover (`cover.deleg`) | Maker for Coastal only, **plus** Om's grants via a 14-day delegation |
| Gita Grant-Changed (`changed.grant`) | Checker for Delta only. Until 10 days ago she was Checker for everything (revoked); she checked `NFPL-DEMO-REVOKED-DONE` under that old grant |
| Farah Filer-All (`filer.all`) / Faisal (`filer.mum`) | Filer for everything / Filer for Mumbai |
| Sunil Supervisor (`super`) | Supervisor, all scopes: cancel/reopen, including Filed jobs; reassign |
| Bina Branch-Mumbai (`bm.mumbai`) / Bhavya (`bm.delhi`) | BranchManager for Mumbai / Delhi: cancel/reopen unfiled jobs, reassign, grant Maker/Checker/Filer inside their own branch |
| Mohan (`maker.mum`), Maya (`maker.del`), Murali (`maker.chennai`) | Maker for Mumbai / Delhi / Chennai |
| Charu Checker-All (`checker.all`), Kabir (`checker.kol`) | Checker for everything / Kolkata |
| Alok (`client.acme`), Bhumi (`client.bharat`) | Client-side, read-only, own client only, no internal notes |
| Overnight Parser (`parser`) | Service account: create/update jobs only; never Filed jobs; cannot move stages; sees nothing |

Named jobs: `NFPL-DEMO-CONFLICT`, `-ACME-PREP`, `-DELTA-PREP`, `-EXPORT-NARROW`, `-ABSENT-1..3`, `-REVOKED-OPEN`, `-REVOKED-DONE`, `-FILED`, `-CANCELLED`, `-REOPENED`, plus ~300 random jobs `NFPL-2026xxx`. The audit log also contains a blocked admin self-escalation attempt.

## Layout

```
backend/  db/ (schema.sql, migrate.js, seed.js, seedScale.js)  src/ (app, permissions, queries, routes, services)  tests/
frontend/ src/ (App, api, components/ Login Dashboard JobDetail WhyPanel GrantsAdmin)
```

API summary: `POST /auth/login`, `GET /me`, `GET /jobs?view=all|waiting&page=&q=`, `GET /jobs/waiting/count`, `GET /jobs/:id`, `POST /jobs/:id/actions`, `GET /jobs/:id/can?action=&user_id=`, `GET /jobs/:id/history`, `GET /jobs/:id/who-could-have?date=`, `GET|POST /grants`, `POST /grants/:id/revoke`, `POST /delegations`, `POST /jobs/:id/reassign`, `POST /parser/jobs`.
