# Running OpsFlow locally

A step-by-step guide to get OpsFlow (the LabStack Ops console, a.k.a. TaskOs)
running on your machine with a seeded database. Follow it top to bottom.

If you just want the fastest path: **[Docker quickstart](#option-a--docker-recommended)**.
For deeper Docker topics (external DBs, admin password reset, volumes) see
[`DOCKER.md`](../DOCKER.md).

---

## 1. What you're running, in one minute

OpsFlow watches a lab's operational data and turns it into a live task board:
rules poll a **source database**, spin up tasks (confirm booking, chase a
sample, follow up a report…), assign them to agents, and track SLAs.

There are **two databases**, and understanding the split is the key to setup:

| Database | Env var | OpsFlow's access | Holds |
|---|---|---|---|
| **taskos** (OpsFlow's own) | `DATABASE_URL` | read **+ write** | tasks, rules, teams, sessions, history — the `taskos` schema |
| **source** (LabStack) | `SOURCE_DATABASE_URL` | **read-only** | orders, appointments, users, stores — the `public` schema |

- **taskos** is created and seeded for you locally (bundled Postgres container).
- **source** is your existing LabStack-style Postgres. It's **optional** for a
  first run — leave it blank and the app + UI work fine; the rule engine just
  has nothing to poll (no tasks get auto-created). See
  [§6 Seeing real tasks](#6-seeing-real-tasks-the-source-database).
- If `SOURCE_DATABASE_URL` is blank it **falls back to `DATABASE_URL`**, so the
  engine reads the `public` schema of the same Postgres.

Stack: Next.js 15 (App Router) · React 19 · Prisma 4.16 · PostgreSQL 16 · Node 20.

> ⚠️ This is a **customised** Next.js build — see [`AGENTS.md`](../AGENTS.md)
> before changing framework-level code.

---

## Option A — Docker (recommended)

Everything (Postgres + app) runs in containers. Nothing to install but Docker.

### Prerequisites
- Docker Desktop (or Docker Engine) with Compose v2 — check with
  `docker compose version`.

### Steps

```bash
# 1. Clone and enter the repo
git clone <your-repo-url> opsflow && cd opsflow

# 2. Create your env file from the template
cp .env.example .env
```

Open `.env` and set at minimum a real JWT secret (everything else has working
local defaults):

```bash
# generate a strong secret and paste it as JWT_SECRET in .env
openssl rand -hex 32
```

`.env` essentials for local:

```dotenv
JWT_SECRET=<paste the openssl output>
# Leave DATABASE_URL blank → uses the bundled Postgres container.
DATABASE_URL=
# Leave blank for a UI-only run; set it to see real tasks (see §6).
SOURCE_DATABASE_URL=
# First-boot admin login (change the password after logging in):
ADMIN_EMAIL=admin@opsflow.local
ADMIN_PASSWORD=changeme123
ADMIN_NAME=Admin
```

```bash
# 3. Build and start the stack (Postgres + app)
docker compose up -d --build
```

On first boot the app container automatically:
1. waits for Postgres,
2. runs `prisma db push` (creates the whole `taskos` schema),
3. seeds one **OPS_HEAD admin** user (idempotent),
4. starts Next.js on **http://localhost:3000**.

```bash
# 4. Load the starter dataset (rules, task types, checklists, etc. — see §5)
docker compose exec -T app npm run db:seed

# 5. Open the app and log in
open http://localhost:3000      # admin@opsflow.local / changeme123
```

That's it — you have a running console. Watch logs with
`docker compose logs -f app`.

### Optional: WhatsApp gateway
The WhatsApp Control Tower needs the Baileys gateway. It's an overlay compose
file and stays in **dry-run** (never sends) until you opt in:

```bash
docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d --build
```

Link a device from the console (Settings → WhatsApp) by scanning the QR. To
actually send, set `WA_DRY_RUN=false` in `.env` and enable per-group in the UI.

---

## Option B — Native (no Docker for the app)

Run Postgres however you like and the Next.js dev server on your host. Good for
fast iteration with hot reload.

### Prerequisites
- **Node 20** (`node -v` → v20.x) and npm
- **PostgreSQL 16** running locally (or reachable)

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Create a database (any name; the taskos schema lives inside it)
createdb opsflow

# 3. Configure env — create .env.local (gitignored, overrides .env)
```

`.env.local`:

```dotenv
DATABASE_URL=postgresql://<you>@localhost:5432/opsflow?schema=taskos
# Optional — point at a source DB to get real tasks (see §6). If blank,
# it falls back to DATABASE_URL (reads the public schema of the same DB).
SOURCE_DATABASE_URL=
JWT_SECRET=<openssl rand -hex 32>
```

```bash
# 4. Generate the Prisma client, create the schema, seed data
npm run db:generate
node node_modules/prisma/build/index.js db push
npm run db:seed

# 5. Run the dev server
npm run dev                     # http://localhost:3000
```

The native path does **not** run the Docker entrypoint, so the admin user comes
from `npm run db:seed` (same credentials: `admin@opsflow.local` / `changeme123`).

---

## 5. What the seed creates (your starter data)

`npm run db:seed` populates the `taskos` schema with a realistic starting
config so the console isn't empty:

- **Admin user** — `admin@opsflow.local` / `changeme123` (OPS_HEAD).
- **Skill tags** — used for skill-based assignment.
- **Task types** — with default **checklists** (e.g. "Confirm Booking",
  "Assign Phlebotomist", "Sample Handover"…).
- **Escalation chain** — a sample multi-level chain.
- **Data source** — "Lab Orders", pointing at the source `public."Order"` table.
- **8 Home Sample Collection rules** — the ruleset that turns orders into tasks.

The seed is **idempotent** (upserts) — safe to re-run.

> The seed configures *how* tasks are made; it does **not** create tasks or
> source records. Tasks appear once the engine has a source DB to poll (§6).

---

## 6. Seeing real tasks (the source database)

Tasks are auto-created by the polling engine from the **source** DB. To see
them locally you need `SOURCE_DATABASE_URL` pointing at a Postgres that has the
LabStack `public` schema (`Order`, `Appointment`, `User`, `Store`, `Lab`, …)
with data. The account only needs **SELECT** — OpsFlow never writes there.

```dotenv
# .env (Docker) or .env.local (native)
SOURCE_DATABASE_URL=postgresql://reader:secret@host.docker.internal:5432/labstack
```

- From inside Docker use `host.docker.internal` (not `localhost`) to reach a
  Postgres on your host machine.
- The engine polls every `POLLING_INTERVAL_MS` (default 5 min). Trigger a cycle
  immediately from the console (Engine page) or the debug poller endpoint.

Without a source DB the app still runs — you can log in, browse rules, teams,
analytics, and settings; there just won't be any live tasks on the board.

---

## 7. Handy commands

```bash
# Docker
docker compose logs -f app                         # tail app logs
docker compose exec -T app npm run db:seed         # (re)seed starter data
docker compose down                                # stop (keeps data)
docker compose down -v                             # stop + WIPE the taskos volume

# Prisma (native, or inside the container)
npm run db:studio                                  # browse the DB in a UI
node node_modules/prisma/build/index.js db push    # apply schema.prisma to the DB
npm run db:generate                                # regenerate the Prisma client
```

After changing `prisma/schema.prisma`, always run **`db push`** *and*
**`db:generate`** (in Docker: `docker compose exec -T app sh -c "npx prisma db
push && npx prisma generate" && docker compose restart app`).

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Port 3000 already in use | set `APP_PORT` in `.env` (Docker) or run `next dev -p 3001`. |
| Port 5433 already in use | set `DB_PORT` in `.env`. |
| `DATABASE_URL is not set` on boot | ensure `.env` exists; for an external DB it must include `?schema=taskos`. |
| App refuses to start in prod over `JWT_SECRET` | set a ≥32-char secret (`openssl rand -hex 32`). |
| `prisma db push` fails on enum drift | set `SKIP_PRISMA_PUSH=true` and reconcile the schema manually (see `DOCKER.md`). |
| "Unknown field …" / stale Prisma client | run `db:generate` (Docker: `npx prisma generate` then restart `app`). |
| Board is empty | expected without a source DB — see §6. |
| Reset everything | `docker compose down -v && docker compose up -d --build` (destroys local data). |

---

## Reference
- **All environment variables:** [`.env.example`](../.env.example) (annotated).
- **Docker specifics** (external/managed DBs, admin reset, persistence):
  [`DOCKER.md`](../DOCKER.md).
- **Working on the (customised) Next.js build:** [`AGENTS.md`](../AGENTS.md).
