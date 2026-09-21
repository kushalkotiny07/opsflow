# OpsFlow (TaskOs)

OpsFlow is the LabStack Ops console: it watches operational data (orders,
appointments, …) from a read-only source database, turns it into a live task
board via configurable rules, auto-assigns work to agents, and tracks SLAs —
plus a WhatsApp Control Tower for provider/store coordination.

Stack: **Next.js 15** (App Router) · **React 19** · **Prisma 4.16** ·
**PostgreSQL 16** · **Node 20**.

## Getting started

👉 **[DOCS/LOCAL_SETUP.md](DOCS/LOCAL_SETUP.md)** — clone-to-running guide with a
seeded database (Docker or native).

Fastest path (Docker):

```bash
cp .env.example .env                     # set JWT_SECRET (openssl rand -hex 32)
docker compose up -d --build             # starts Postgres + app on :3000
docker compose exec -T app npm run db:seed   # load starter data (rules, task types…)
open http://localhost:3000               # login: admin@opsflow.local / changeme123
```

## Documentation

- **[DOCS/LOCAL_SETUP.md](DOCS/LOCAL_SETUP.md)** — local setup, seeding, and the
  two-database (taskos vs source) model.
- **[DOCKER.md](DOCKER.md)** — Docker deep-dive: external/managed databases,
  admin password reset, data persistence, troubleshooting.
- **[AGENTS.md](AGENTS.md)** — this is a customised Next.js build; read before
  touching framework-level code.

## Environment

All variables are documented in **[.env.example](.env.example)**. The only one
you must set is `JWT_SECRET`; `DATABASE_URL` defaults to the bundled Postgres
and `SOURCE_DATABASE_URL` is optional (blank = UI-only, no live tasks).
