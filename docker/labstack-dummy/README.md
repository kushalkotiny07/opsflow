# Local LabStack stand-in (dummy data)

OpsFlow does not own its source data. It reads orders straight out of the
LabStack Postgres — `public."Order"` joined to `"User"` / `"Lab"` / `"Store"`,
with `orderType` / `orderStatus` as native pg enums — through
`SOURCE_DATABASE_URL`. Locally that variable was blank, so the rule engine
polled nothing and every board was empty.

This directory stands that database up in Docker and seeds it with the
**"Labstacks orders" sheet**: 215 orders, 210 patients, 13 labs, 9 partner
stores. It is dummy data for local development — not a replica, not a dump,
and not something to point at production.

## Run it

```bash
npm run dummy:up      # taskos db + app + labstack-db, SOURCE_DATABASE_URL wired
open http://localhost:3000
```

That is `docker compose -f docker-compose.yml -f docker-compose.labstack-dummy.yml
up -d --build`. The plain `docker compose up` stack is untouched — no dummy
data unless you ask for the overlay.

| Script | What it does |
| --- | --- |
| `npm run dummy:up` | Bring up the stack with the dummy source DB attached |
| `npm run dummy:down` | Stop it (data survives in the `opsflow_labstack_dummy_data` volume) |
| `npm run dummy:realign` | **Daily refresh.** Shifts the sheet onto today, re-derives tasks |
| `npm run dummy:team` | 5 agents with skills, 7-day schedules, stores, capabilities |
| `npm run dummy:labs` | Points Provider Communication at real labs (4 NON_API + 1 API) |
| `npm run dummy:activity` | Simulates a partly-worked day (completions, WIP, snoozes) |
| `npm run wa:test-sla` | End-to-end test: the NON_API confirmation ladder → message to the lab's WhatsApp group (self-cleaning) |
| `npm run wa:test-breach` | End-to-end test: an SLA breach messages the lab — including an **API** lab (self-cleaning) |
| `npm run dummy:reseed` | Re-run `02-seed.sql` — full reload of the source rows |
| `npm run dummy:psql` | psql shell on the dummy source DB |
| `npm run dummy:generate` | Rebuild `02-seed.sql` from the CSVs |

### Full setup, in order

```bash
npm run dummy:up        # source DB + app
npm run db:seed         # skill tags, task types, the 8 HSC rules, admin user
npm run dummy:team      # agents — without these every task stays unassigned
npm run dummy:labs      # Provider Communication wired to real lab ids
npm run dummy:realign   # land the data on today and build tasks
npm run dummy:activity  # optional: give the throughput metrics something to read
```

Each script is idempotent, so re-running any of them is safe.

### Why `dummy:realign` is the one to remember

The sheet is a single operating day. One day after loading, every appointment
is "yesterday": Smart View's **Today** bucket empties and the whole backlog
falls into **Stuck** (its bucket for prior-day appointments that never
resolved). `dummy:realign` fixes that in three steps — shift the source, clear
the tasks, re-poll — because the engine dedups on `(rule, entityId)` and only
reopens rows it retired itself, so it will *not* refresh `appointmentTime` on
a task that already exists. Shifting the source alone leaves every task stale.

Host port is **5434** (5432 is your own Postgres, 5433 the taskos `db`
container), so a host-run `npm run dev` can use it too:

```
SOURCE_DATABASE_URL=postgresql://labstack:labstack_dev_password@localhost:5434/labstack
```

## What's here

```
01-schema.sql          enums + tables (runs first on container init)
02-seed.sql            GENERATED — the sheet as INSERTs
generate-seed.mjs      data/*.csv → 02-seed.sql
realign.sql            in-place day shift of the source rows
realign.sh             realign.sql + task rebuild + poll (npm run dummy:realign)
data/orders.csv        215 order rows from the sheet
data/labs.csv          13 labs, real ids from the sheet
data/stores.csv        9 partner stores, real ids from the sheet
```

Postgres runs `docker-entrypoint-initdb.d/*.sql` in name order, **on first
boot only**. The directory is mounted rather than copied, so the same files
stay reachable inside the container for `npm run dummy:reseed`.

## Two things the seed does on purpose

**Timestamps are IST → naive UTC.** The sheet shows IST wall-clock
("appointment 7:00" = 7 AM in Bengaluru). Real LabStack stores
`TIMESTAMP WITHOUT TIME ZONE` holding the *UTC* instant, and OpsFlow reads it
that way — see the long timestamp note atop `src/lib/engine/labstack.ts`,
including the 5h30m drift bug that came from getting this backwards. So the
seed writes `ts - 5:30` and the UI renders the sheet's original IST time back.

**The sheet's day becomes today, at insert time.** The export is one
operating day, 2026-08-17. The poller only fetches orders whose
`appointmentTime` falls inside `NOW() ± 10 days`
(`APPT_WINDOW_SQL`), so hard-coded August dates would quietly go invisible a
fortnight later. Every timestamp is emitted as
`dummy_day_shift('<literal>')`, which adds `CURRENT_DATE - 2026-08-17` whole
days. Load it any day and the snapshot lands on that day with every internal
gap — created→appointment→collected — intact.

The data ages once loaded, though — one day per day. `npm run dummy:realign`
shifts it back onto today and rebuilds the tasks; `npm run dummy:reseed`
reloads the rows from scratch if you would rather start clean.

## Where the data came from, and where it was interpreted

Everything in `data/` is transcribed from the sheet. Three notes on
judgement calls:

- **Only LabStack-shaped columns were kept.** The sheet's SLA columns
  (`SLA (Latest)`, `Milestones Tracked/Missed`, `Next SLA Deadline`, TAT,
  collection minutes) are values *OpsFlow computes* from task rules, not
  columns LabStack serves — keeping them would have meant seeding a source
  database with its consumer's output. They are dropped; the engine derives
  its own. Same for `Found/Req. Params`.
- **Patients are keyed on name + mobile, not mobile alone.** Several numbers
  in the sheet are shared between family members (9765720651, 9632365115,
  9256298216, 9403276790). Keying on the number alone would have merged two
  people into one patient record.
- **Order 73486's lab is inferred.** Its lab name cell was garbled in the
  export, but its lab id is 2 and its lab order id (18367274) sits in
  Redcliffe's numbering series, so it is seeded as Redcliffe Labs Pvt Ltd.

No phlebo names or numbers are seeded — the sheet has no phlebo columns, so
`phleboName` / `phleboNumber` stay NULL rather than being invented. Rules
whose titles interpolate `{{phleboName}}` will render it empty.

`public."Request"` and `public."Appointment"` are created but empty: the app
queries them (WhatsApp ticket context, the Data Sources table picker), and
the sheet has nothing to put in them. They exist so those paths return "no
rows" instead of erroring on a missing relation.

## Provider communication covers API labs too

There are two triggers, and only one of them is restricted by integration type:

| Trigger | NON_API lab | API lab |
| --- | --- | --- |
| Confirmation ladder — accept / reschedule / cannot fulfil | ✅ | ✗ |
| **SLA breach alert** — "order N is past its deadline" | ✅ | ✅ |

The ladder asks a provider to confirm an order over WhatsApp, which an API lab
has already received through the API — sending it would be noise. A breach is
different: a missed deadline is worth reporting however the order arrived. So
`npm run dummy:labs` seeds Orange Health - Bangalore (lab 4, the sheet's
busiest at 52 orders) as `API` — without at least one API lab, this path looks
identical to the old NON_API-only behaviour.

Breach alerts are queued by the SLA watcher, which runs inside every poll
cycle: when a task is marked `BREACHED`, the order's lab is looked up in the
source (tasks carry an order id but no lab id) and messaged. Repetition is
capped **per order** — `slaBreachMaxPerOrder`, default 2 — because one order
can breach several task rules in a row. It is deliberately *not* capped per
lab; `src/lib/provider-comms/sla-breach.ts` explains why both a lab-wide quiet
window and cross-order suppression were tried and rejected.

The breach message carries no accept/reschedule link. Those are bearer tokens
minted against a confirmation workflow, and an API lab never has one, so a
template that required them could not be sent to half the labs it is for.

## Provider messaging goes to a group, not a handset

Each configured lab is addressed by `waGroupJid` — the provider's WhatsApp
group ("…@g.us") — so a reply is visible to their whole desk rather than
sitting in one person's chat. `whatsappNumber` remains as a fallback for labs
that only have a handset, and the resolver prefers the group when both exist.
There is **no manager** on these configs: escalations go back to the same
group.

Two things make that safe:

- A group send always carries `wa_outbound.groupId`, which is what arms the
  gateway's per-group `sendEnabled` guard. A bare jid with a null groupId
  would sail straight past it, so `lib/non-api-labs/target.ts` registers any
  unseen group as a `wa_groups` row with `sendEnabled = false` and attaches
  its id. Messages queue, the drain refuses them with *"sending disabled for
  group …"*, and nothing reaches WhatsApp until a human enables that group
  under Settings → WhatsApp.
- The seeded group ids are fabricated (`1203630000000000NN@g.us`) and reach
  nobody.

`npm run wa:test-breach` proves the breach chain end to end on two throwaway
labs — one API, one with alerts switched off. It asserts the API lab *is*
messaged, that the row carries no workflow (an API lab has none), that the
target is the group jid with `groupId` attached, that the per-order cap and the
per-task idempotency hold, and that a send-disabled group is refused by the
real drain. `npm run wa:test-sla` covers the NON_API ladder on a throwaway lab: a
past-due order → workflow → ladder rungs backdated past their SLA → the real
tick → the **real gateway drain** with a fake transport → `SENT`. It asserts
the target is the group jid rather than `<digits>@s.whatsapp.net`, that
`groupId` is attached, and that a send-disabled group is refused — then
deletes everything it created, including on failure.

## What still needs something beyond the sheet

**The WhatsApp console.** `wa_groups`, `wa_tickets`, `wa_messages` and friends
are created but empty, so the console, its analytics and the ticket views all
render their empty states. Populating them needs the `wa-gateway` service and a
linked device (Settings → WhatsApp shows the QR) — the orders sheet contains no
conversations, and inventing message history would put words in providers'
mouths. Everything else in the app reads real seeded rows.

**The provider-facing action page** (`/provider/action/[token]`). Tokens are
stored hashed, so the raw token only ever exists inside the message that was
dispatched. With no gateway, communications stop at `QUEUED` and there is no
raw token to open the page with. The route itself is fine; it just needs a real
dispatch to be reachable.
