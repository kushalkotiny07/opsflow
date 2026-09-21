-- Stop the gateway sending one message twice.
--
-- drainOutbound ran on a 4-second setInterval, SELECTed up to 5 QUEUED rows,
-- then marked each SENDING one at a time INSIDE its send loop. A batch takes
-- longer than 4 seconds, so the next interval fired mid-batch and re-selected
-- the rows the first pass had not reached yet — and sent them again. Order
-- 999404 went to the provider twice on 2026-09-17 this way; it was last in a
-- batch of four, so it was exposed the longest.
--
-- The fix is an atomic claim (UPDATE ... FOR UPDATE SKIP LOCKED) in
-- controltower.mjs. This column supports the other half: reclaimStalledSends
-- judged staleness from "createdAt", which is when the row was QUEUED, not
-- when sending began. A row that waited out a gateway outage was therefore
-- born eligible for reclaim the instant it started sending.
--
-- Applied with `prisma db execute`, like the other files in this directory.

ALTER TABLE taskos.wa_outbound ADD COLUMN IF NOT EXISTS "sendingAt" TIMESTAMP(3);

-- Lets the claim's inner SELECT reach the oldest queued rows without a scan.
CREATE INDEX IF NOT EXISTS "wa_outbound_status_createdAt_idx"
  ON taskos.wa_outbound ("status", "createdAt");
