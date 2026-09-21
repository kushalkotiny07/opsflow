-- Test fixtures for the daily digest + confirmation poll, 2026-09-21.
-- Ids in the 9995xx range so they are trivially identifiable and removable.
--
-- appointmentTime is stored UTC (IST = UTC+5:30). Statuses are deliberately
-- mixed so today's counters are not all the same number — a digest where
-- collected/pending/reports all read the same proves nothing.
INSERT INTO public."Order"
  (id, "userId", "storeId", "labId", "orderType", "orderStatus", "appointmentTime",
   city, pincode, "packageName", "createdAt", "updatedAt")
VALUES
  -- TODAY (2026-09-21)
  (999501, 500005, 6,  378, 'HOME_SAMPLE',  'ORDER_SCHEDULED',  '2026-09-21 14:30:00', 'Indiranagar',  '560038', 'Full Body Checkup',   now(), now()),
  (999502, 500006, 6,  378, 'HOME_SAMPLE',  'SAMPLE_COLLECTED', '2026-09-21 06:00:00', 'Koramangala',  '560034', 'Thyroid Profile',     now(), now()),
  (999503, 500007, 16, 378, 'CENTER_VISIT', 'SAMPLE_PROCESSED', '2026-09-21 04:30:00', 'Jayanagar',    '560041', 'Lipid Profile',       now(), now()),
  -- TOMORROW (2026-09-22)
  (999504, 500008, 6,  378, 'HOME_SAMPLE',  'ORDER_SCHEDULED',  '2026-09-22 02:00:00', 'Whitefield',   '560066', 'Vitamin D Test',      now(), now()),
  (999505, 500001, 6,  378, 'HOME_SAMPLE',  'ORDER_SCHEDULED',  '2026-09-22 03:30:00', 'HSR Layout',   '560102', 'Liver Function Test', now(), now()),
  (999506, 500002, 16, 378, 'CENTER_VISIT', 'ORDER_SCHEDULED',  '2026-09-22 06:15:00', 'Basavanagudi', '560004', 'Complete Blood Count',now(), now())
ON CONFLICT (id) DO NOTHING;
