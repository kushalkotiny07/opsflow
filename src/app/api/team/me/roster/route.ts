/**
 * PATCH /api/team/me/roster
 * Agent sets their own roster status for today.
 * Body: { status: RosterStatus, note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { RosterStatus } from "@prisma/client";
import { computeRosterStatus } from "@/lib/roster/availability";

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { status, note } = body;

  if (!status || !Object.values(RosterStatus).includes(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${Object.values(RosterStatus).join(", ")}` },
      { status: 400 }
    );
  }

  const teamMember = await prisma.teamMember.findUnique({ where: { userId: user.id } });
  if (!teamMember) {
    return NextResponse.json({ error: "No team member profile found for your account" }, { status: 404 });
  }

  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const entry = await prisma.dailyRoster.upsert({
    where: { teamMemberId_date: { teamMemberId: teamMember.id, date } },
    create: { teamMemberId: teamMember.id, date, status, note: note ?? null },
    update: { status, note: note ?? null },
  });

  return NextResponse.json({ entry });
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const teamMember = await prisma.teamMember.findUnique({ where: { userId: user.id } });
  if (!teamMember) return NextResponse.json({ status: null });

  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDay = new Date(date.getTime() + 86_400_000);

  const entry = await prisma.dailyRoster.findFirst({
    where: { teamMemberId: teamMember.id, date: { gte: date, lt: nextDay } },
  });
  if (entry) return NextResponse.json({ status: entry.status, note: entry.note ?? null, source: "self" });

  // No self-declared entry for today. Falling back to a hard-coded "OFF" told
  // agents they were off shift while the engine — which reads WeeklySchedule +
  // RosterException via computeRosterStatus, never daily_rosters — was busy
  // assigning them work. Compute the same way the engine and GET /api/team do,
  // so all three agree.
  const [schedule, exception] = await Promise.all([
    prisma.weeklySchedule.findFirst({
      where: { teamMemberId: teamMember.id, dayOfWeek: now.getDay() },
    }),
    prisma.rosterException.findFirst({
      where: { teamMemberId: teamMember.id, date: { gte: date, lt: nextDay } },
    }),
  ]);

  return NextResponse.json({
    status: computeRosterStatus(schedule, exception, now),
    note: exception?.note ?? null,
    source: "schedule",
  });
}
