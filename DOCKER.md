# Running OpsFlow in Docker

The default Docker setup is **self-contained**: it spins up its own
Postgres for the `taskos` schema (tasks, alerts, sessions, rules,
history) and connects to your existing source DB (labstack — orders,
appointments, users, stores) read-only.

On first boot the app container:

1. Waits for its Postgres (`db` service) to accept connections.
2. Applies the `taskos` schema (`prisma db push`) — idempotent.
3. Seeds exactly one OPS_HEAD admin user (idempotent upsert).
4. Starts Next.js on port 3000.

The source DB (`SOURCE_DATABASE_URL`) is read-only and never modified by
OpsFlow.

## Quickstart

```bash
# 1. Copy the example and (optionally) set SOURCE_DATABASE_URL to your
#    existing labstack DB:
cp .env.example .env
$EDITOR .env
#   ↳ Most users only need to set SOURCE_DATABASE_URL.
#     DATABASE_URL defaults to the bundled Postgres container.

# 2. Bring up the stack (db + app)
docker compose up -d --build

# 3. Open
open http://localhost:3000
```

Default login:

| Field | Default |
|---|---|
| Email | `admin@opsflow.local` |
| Password | `changeme123` |

Change either before exposing the app — set `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env` (only effective on **first** boot; see
"Resetting the admin password" below for after).

## What lives where

| | Where it's stored | Set by |
|---|---|---|
| Tasks, alerts, sessions, rules, history | `db` container (`taskos` schema) | `DATABASE_URL` |
| Orders, appointments, users, stores, labs | Your existing labstack DB | `SOURCE_DATABASE_URL` |

If `SOURCE_DATABASE_URL` is blank, the engine reads from `DATABASE_URL`
instead — useful for a purely-local stack with no real source data,
where the rule engine just has nothing to act on but the UI works.

## Alternative shapes

### Dummy source data (no real LabStack needed)

With `SOURCE_DATABASE_URL` blank the app runs but the rule engine has
nothing to poll, so every board is empty. The `labstack-dummy` overlay adds
a third container, `labstack-db`, shaped like the LabStack database OpsFlow
reads and seeded from the "Labstacks orders" sheet — 215 orders, 210
patients, 13 labs, 9 partner stores — then points the app at it:

```bash
npm run dummy:up      # = docker compose -f docker-compose.yml \
                      #     -f docker-compose.labstack-dummy.yml up -d --build
open http://localhost:3000
```

A poll cycle against it creates a few hundred tasks across the seeded HSC
rules. Three companion seeds finish the environment — `npm run dummy:team`
(agents, without which every task stays unassigned), `npm run dummy:labs`
(Provider Communication pointed at real lab ids) and `npm run dummy:activity`
(a partly-worked day, so the throughput metrics have something to read).

The seed shifts the sheet's operating day onto the day you load it, so the
orders sit inside the poller's `NOW() ± 10 days` appointment window. It then
ages a day per day — `npm run dummy:realign` shifts it back onto today and
rebuilds the tasks, which is the one command worth remembering.
Host port is `5434`. Details, and the judgement calls made while
transcribing the sheet, are in `docker/labstack-dummy/README.md`.

### External taskos DB (skip bundled Postgres)

If you have an existing Postgres you want OpsFlow to use for `taskos`:

```env
# .env
DATABASE_URL=postgresql://opsflow:secret@your-host:5432/opsflow?schema=taskos
SOURCE_DATABASE_URL=postgresql://reader:secret@labstack-prod:5432/labstack
```

Then start only the app (skip the bundled `db`):

```bash
docker compose up -d app
```

### Single-DB mode (taskos lives inside the source DB)

If you'd rather have OpsFlow create the `taskos` schema **inside** your
labstack DB (the original deployment shape):

```env
DATABASE_URL=postgresql://USER:PASS@labstack-host:5432/labstack?schema=taskos
SOURCE_DATABASE_URL=     # leave blank — falls back to DATABASE_URL
```

```bash
docker compose up -d app
```

Then `prisma db push` creates the `taskos` schema next to `public` in
the same database, and reads source data from the same connection.

### Managed Postgres (RDS / Supabase / Aiven / etc.)

Add `?sslmode=require` to both URLs:

```env
DATABASE_URL=postgresql://opsflow:pass@db.example.com:5432/opsflow?schema=taskos&sslmode=require
SOURCE_DATABASE_URL=postgresql://reader:pass@labstack.example.com:5432/labstack?sslmode=require
```

## Subsequent runs

```bash
docker compose up -d
```

Both `prisma db push` and the admin seed are idempotent — nothing is
overwritten.

## Data persistence

Taskos data lives in the named volume `opsflow_taskos_data` and survives
`docker compose down`. It's only removed by an explicit `down -v`:

```bash
docker compose down       # stop containers; KEEP data
docker compose down -v    # stop containers AND wipe taskos DB
```

Back up the volume with standard Docker tools:

```bash
docker run --rm -v opsflow_taskos_data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/taskos-backup-$(date +%F).tar.gz -C /data .
```

## Resetting the admin password

The seed only sets the password on **first** boot — subsequent boots
don't overwrite it (so a deploy doesn't reset your password). To change
it later:

```bash
docker compose exec app node -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();
(async () => {
  const hash = await bcrypt.hash(process.argv[1], 10);
  await p.user.update({ where: { email: 'admin@opsflow.local' }, data: { passwordHash: hash } });
  console.log('done');
  await p.\$disconnect();
})();
" YOUR_NEW_PASSWORD
```

## Logs

```bash
docker compose logs -f app
docker compose logs -f db
```

## Connecting to a Postgres on the host

When `SOURCE_DATABASE_URL` points at a Postgres running on your host
machine (not in Docker), use `host.docker.internal` instead of
`localhost`:

```env
SOURCE_DATABASE_URL=postgresql://USER:PASS@host.docker.internal:5432/labstack
```

The compose file adds the `host-gateway` mapping for Linux, where
`host.docker.internal` doesn't resolve by default on plain Docker
(Docker Desktop adds it automatically on macOS/Windows).

## Troubleshooting

**`✘ DATABASE_URL is not set`** — `.env` missing entirely. Run
`cp .env.example .env`.

**`✘ database not reachable after 60s`** — the app container can't
reach the DB host you configured. Test from inside:

```bash
docker compose exec app sh
pg_isready -h <host> -p <port>
```

For the bundled `db`, the host is literally `db`. For external, make
sure the DB is actually listening on the right IP (often `0.0.0.0`, not
just `localhost`).

**`prisma db push` complains about drift** — your DB has columns the
schema doesn't know about. Either accept the drift (`--accept-data-loss`
is already passed by the entrypoint) or drop the schema and restart:

```bash
docker compose exec app sh -c '
node -e "
const { PrismaClient } = require(\"@prisma/client\");
const p = new PrismaClient();
p.\$executeRawUnsafe(\"DROP SCHEMA IF EXISTS taskos CASCADE\").then(() => { console.log(\"dropped\"); return p.\$disconnect(); });
"'
docker compose restart app
```

**Bundled `db` won't start** — port `5433` is already in use on the
host (e.g., another Postgres). Override with `DB_PORT=5434` in `.env`,
or remove the `ports:` mapping from the `db` service if you don't need
host access.

**Tasks disappeared after restart** — you probably ran
`docker compose down -v` which wipes the volume. Use plain
`docker compose down` to keep data.
