#!/bin/sh
# Bring the dummy environment back to "today" end to end.
#
# Three steps, because shifting the source alone is not enough:
#
#   1. Shift the source rows onto today (realign.sql).
#   2. Wipe the OpsFlow tasks. The engine dedups on (rule, entityId) and only
#      reopens rows it retired itself — it does NOT refresh appointmentTime on
#      an existing open task. So without this the tasks keep yesterday's
#      appointment and stay in Stuck no matter how often the poller runs.
#      This is the same wipe-then-repoll pattern prisma/wipe_all_tasks.ts
#      documents for "source data changed underneath the tasks".
#   3. Trigger a poll so the tasks come back dated today.
#
# Dummy data only. Step 2 deletes every task in the taskos schema.
set -e
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.labstack-dummy.yml"
DB_USER="${LABSTACK_DB_USER:-labstack}"
DB_NAME="${LABSTACK_DB_NAME:-labstack}"
APP_URL="${NEXT_PUBLIC_APP_URL:-http://localhost:3000}"

echo "→ 1/3  Shifting dummy source data onto today…"
$COMPOSE exec -T labstack-db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
  -f /docker-entrypoint-initdb.d/realign.sql

echo "→ 2/3  Clearing tasks so the engine re-derives them…"
node node_modules/.bin/tsx prisma/wipe_all_tasks.ts

echo "→ 3/3  Triggering a poll cycle…"
if curl -fsS -m 300 "$APP_URL/api/debug/trigger-poller" >/dev/null 2>&1; then
  echo "✔ Poll cycle run — tasks rebuilt for today."
else
  echo "• App not reachable at $APP_URL — the 5-minute poller cron will rebuild them."
fi
