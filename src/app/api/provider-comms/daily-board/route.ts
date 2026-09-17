/**
 * GET /api/provider-comms/daily-board — today and tomorrow, per provider.
 *
 * Answers the question an Ops head actually starts the day with: for each lab
 * we talk to, how much work is coming, how much of it they have confirmed, and
 * what is already going wrong. PRD §31 (daily provider business summary) and
 * §41 (operations dashboard, built around exceptions).
 *
 * Two sources, joined per lab:
 *   LabStack  — the orders themselves, counted by day and status
 *   OpsFlow   — whether the provider has actually answered, from the
 *               confirmation workflows and their communication history
 *
 * "Today" and "tomorrow" are in the operating timezone, not UTC. A board that
 * rolls over at 05:30 local would be wrong for exactly the people using it.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
// Counted in one place, shared with the WhatsApp digest the provider itself
// receives. A board that says 14 while the message says 11 destroys trust in
// both, so neither owns the query. See lib/provider-comms/day-summary.ts.
import {
  loadDaySummaries, todayKey, tomorrowKey, TIME_ZONE, type DayCounts,
} from "@/lib/provider-comms/day-summary";

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const configs = await prisma.nonApiLabConfig.findMany({
      orderBy: [{ isActive: "desc" }, { labName: "asc" }],
    });
    if (configs.length === 0) return NextResponse.json({ labs: [], generatedAt: new Date().toISOString() });

    const labIds = configs.map((config) => config.labId);
    const zone = TIME_ZONE();
    const summaries = await loadDaySummaries(labIds, zone);

    // How the provider is answering us — the half LabStack cannot know.
    const workflows = await prisma.labCommunicationWorkflow.groupBy({
      by: ["labId", "status"],
      where: { labId: { in: labIds } },
      _count: true,
    });

    // Milestone breaches still unresolved — the exceptions §41 wants surfaced.
    const openBreaches = await prisma.slaBreachEvent.groupBy({
      by: ["labId"],
      where: { labId: { in: labIds }, status: "ACTIVE" },
      _count: true,
    });

    const today = todayKey(zone);
    const tomorrow = tomorrowKey(zone);
    /** Dates cross the wire as ISO strings; everything else is already a number. */
    const serialize = (counts: DayCounts) => ({
      ...counts,
      firstAppointment: counts.firstAppointment?.toISOString() ?? null,
      nextAppointment: counts.nextAppointment?.toISOString() ?? null,
    });

    const labs = configs.map((config) => {
      const mine = workflows.filter((w) => w.labId === config.labId);
      const count = (status: string) => mine.find((w) => w.status === status)?._count ?? 0;
      return {
        labId: config.labId,
        labName: config.labName,
        integrationType: config.integrationType,
        isActive: config.isActive,
        // A lab with no target cannot be chased, however many orders it has.
        reachable: !!(config.waGroupJid || config.whatsappNumber),
        today: serialize(summaries.get(config.labId)!.today),
        tomorrow: serialize(summaries.get(config.labId)!.tomorrow),
        confirmation: {
          awaiting: count("WAITING_FOR_LAB_CONFIRMATION"),
          accepted: count("LAB_ACCEPTED"),
          rescheduleRequested: count("LAB_RESCHEDULE_REQUESTED"),
          rejected: count("LAB_REJECTED"),
          escalated: count("ESCALATED"),
        },
        openBreaches: openBreaches.find((b) => b.labId === config.labId)?._count ?? 0,
      };
    });

    return NextResponse.json({ labs, timeZone: zone, today, tomorrow, generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId, scope: "ProviderCommsDailyBoardAPI.GET", code: "FETCH_ERROR",
        userMessage: "Failed to load the provider board", error,
      }),
      { status: 500 },
    );
  }
}
