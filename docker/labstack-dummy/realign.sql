-- Re-align the dummy sheet onto today, in place.
--
-- The seed lands the sheet's operating day on whatever day it is loaded, but
-- the rows then age: one day later every appointment is "yesterday", so the
-- poller's NOW() ± 10 day window still sees them while Smart View's Today
-- bucket goes empty and all 400-odd tasks pile into Stuck (the bucket for
-- prior-day appointments that never resolved).
--
-- This shifts every timestamp forward by whole days so the data's operating
-- day is today again. Unlike 02-seed.sql it is an UPDATE, not a reload: ids,
-- patients and any local edits survive.
--
-- Idempotent — running it twice in one day computes a zero shift and no-ops.
--
-- Run: npm run dummy:realign   (which also re-derives the OpsFlow tasks;
--                               the source shift alone leaves them stale)
DO $$
DECLARE
  data_day   date;
  shift_days int;
BEGIN
  -- The sheet is one operating day, so the latest appointment date IS that
  -- day. Read it in IST, the timezone the operating day is defined in.
  SELECT max(("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date)
    INTO data_day
    FROM public."Order";

  IF data_day IS NULL THEN
    RAISE NOTICE 'No orders present — nothing to realign. Run the seed first.';
    RETURN;
  END IF;

  shift_days := CURRENT_DATE - data_day;

  IF shift_days = 0 THEN
    RAISE NOTICE 'Already aligned on % — no shift applied.', data_day;
    RETURN;
  END IF;

  RAISE NOTICE 'Shifting dummy data % day(s): % -> %', shift_days, data_day, CURRENT_DATE;

  -- Every timestamp moves by the same whole-day offset, so the internal gaps
  -- (created -> appointment -> collected -> report) stay exactly as the sheet
  -- recorded them. updatedAt/statusUpdatedAt moving forward also makes the
  -- rows look freshly touched, so the engine's incremental fetch picks them up.
  UPDATE public."Order" SET
    "appointmentTime"   = "appointmentTime"   + make_interval(days => shift_days),
    "createdAt"         = "createdAt"         + make_interval(days => shift_days),
    "updatedAt"         = "updatedAt"         + make_interval(days => shift_days),
    "statusUpdatedAt"   = "statusUpdatedAt"   + make_interval(days => shift_days),
    "sampleCollectedAt" = "sampleCollectedAt" + make_interval(days => shift_days),
    "reportDeliveredAt" = "reportDeliveredAt" + make_interval(days => shift_days);

  UPDATE public."Appointment" SET
    "appointmentTime" = "appointmentTime" + make_interval(days => shift_days),
    "createdAt"       = "createdAt"       + make_interval(days => shift_days),
    "updatedAt"       = "updatedAt"       + make_interval(days => shift_days);

  UPDATE public."Request" SET
    "createdAt" = "createdAt" + make_interval(days => shift_days),
    "updatedAt" = "updatedAt" + make_interval(days => shift_days);
END $$;

SELECT
  min(("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date) AS first_appt_day_ist,
  max(("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date) AS last_appt_day_ist,
  count(*) AS orders
FROM public."Order";
