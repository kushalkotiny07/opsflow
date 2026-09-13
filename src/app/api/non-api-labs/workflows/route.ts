import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN" }, { status: 403 });
  }

  const workflows = await prisma.labCommunicationWorkflow.findMany({
    orderBy: { createdAt: "desc" },
    take: 12,
    include: {
      events: { orderBy: { occurredAt: "asc" } },
      auditLogs: { orderBy: { createdAt: "asc" } },
    },
  });

  return NextResponse.json({
    workflows: workflows.map((workflow) => {
      const timeline = [
        ...workflow.events.map((event) => ({
          id: event.id,
          source: "event" as const,
          type: event.type,
          actorType: event.actorType,
          at: event.occurredAt,
          payload: event.payload,
        })),
        ...workflow.auditLogs.map((entry) => ({
          id: entry.id,
          source: "audit" as const,
          type: entry.action,
          actorType: entry.actorType,
          at: entry.createdAt,
          payload: entry.metadata,
        })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      return {
        id: workflow.id,
        orderId: workflow.orderId,
        labId: workflow.labId,
        status: workflow.status,
        createdAt: workflow.createdAt,
        confirmationDeadline: workflow.confirmationDeadline,
        reminderDeadline: workflow.reminderDeadline,
        escalationDeadline: workflow.escalationDeadline,
        timeline,
      };
    }),
  });
}
