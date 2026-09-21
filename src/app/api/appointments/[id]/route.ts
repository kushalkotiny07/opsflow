/**
 * GET /api/appointments/:id — fetch a single appointment from labstack for the
 * task drawer. The Appointments data source is a different entity from Order,
 * so the drawer needs appointment-shaped context (appointment date/time, the
 * doctor + their contact, the meeting link) instead of store/lab/phlebo.
 *
 * Doctor resolves via the slot: Appointment.slot_id → SlotConfig.provider_id →
 * Provider (name, mobile). Patient via Appointment.user_id → User.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";

interface RawAppointmentDetail {
  id: number;
  appointmentType: string;
  appointmentStatus: string;
  appointmentDate: Date | null;
  duration: number | null;
  referenceId: string | null;
  appointmentUrl: string | null;
  notes: string | null;
  internalNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  orderId: number | null;
  patientName: string | null;
  patientMobile: string | null;
  doctorName: string | null;
  doctorMobile: string | null;
  storeName: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const appointmentId = parseInt(id, 10);
  if (isNaN(appointmentId)) return NextResponse.json({ error: "Invalid appointment ID" }, { status: 400 });

  // No timezone cast — labstack stores naive-UTC timestamps (see orders route
  // + labstack.ts). labstackOr degrades to a clean 503 if the replica is stuck.
  const rows = await labstackOr(
    labstack.$queryRawUnsafe<RawAppointmentDetail[]>(
      `SELECT
         a.id,
         a."appointmentType",
         a."appointmentStatus",
         a."appointmentDate",
         a.duration,
         a."referenceId",
         a."appointmentUrl",
         a.notes,
         a."internalNotes",
         a."createdAt",
         a."updatedAt",
         a."order_id"        AS "orderId",
         u.name              AS "patientName",
         u.mobile            AS "patientMobile",
         p.name              AS "doctorName",
         p.mobile            AS "doctorMobile",
         -- Store = the store that CREATED the appointment. There is no store
         -- column on Appointment; the creating store is recorded on its audit
         -- trail (AppointmentAuditEntry, action='Created', actorKind='STORE').
         -- Take that entry's store_id; fall back to the patient's partner store
         -- for any appointment that predates the audit trail.
         COALESCE(cstore."storeName", ustore."storeName") AS "storeName"
       FROM public."Appointment" a
       JOIN public."User" u ON u.id = a.user_id
       LEFT JOIN public."Store" ustore ON ustore.id = u."storeId"
       LEFT JOIN public."SlotConfig" sc ON sc.id = a.slot_id
       LEFT JOIN public."Provider" p ON p.id = sc.provider_id
       LEFT JOIN LATERAL (
         SELECT ae.store_id
         FROM public."AppointmentAuditEntry" ae
         WHERE ae.appointment_id = a.id AND ae.store_id IS NOT NULL
         ORDER BY (ae.action = 'Created') DESC, ae."createdAt" ASC
         LIMIT 1
       ) cae ON true
       LEFT JOIN public."Store" cstore ON cstore.id = cae.store_id
       WHERE a.id = $1
       LIMIT 1`,
      appointmentId,
    ),
    null as RawAppointmentDetail[] | null,
  );

  if (rows === null) {
    return NextResponse.json({ error: "Source database temporarily unavailable" }, { status: 503 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
  }

  const a = rows[0];

  // The appointment's own OpsFlow tasks. Filter by entityType so an ORDER that
  // shares this numeric id doesn't leak its tasks into the appointment drawer
  // (the boards pass entityId straight through, and ids collide across tables).
  const tasks = await prisma.task.findMany({
    where: { entityId: appointmentId, entityType: "APPOINTMENT" },
    select: {
      id: true,
      title: true,
      entityType: true,
      status: true,
      priority: true,
      slaDeadline: true,
      completedAt: true,
      createdAt: true,
      metadata: true,
      assignedTo: { select: { id: true, name: true } },
      taskType: { select: { label: true } },
      checklistItems: {
        orderBy: { stepOrder: "asc" },
        select: { id: true, stepOrder: true, stepText: true, isRequired: true, isDone: true, guidance: true, script: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    appointment: {
      ...a,
      // Trim the provider name (source data has trailing spaces).
      doctorName: a.doctorName ? a.doctorName.trim() : null,
    },
    tasks,
  });
}
