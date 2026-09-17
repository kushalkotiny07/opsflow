/**
 * GET /api/non-api-labs/catalog — every lab LabStack knows about, with whatever
 * provider-communication configuration OpsFlow holds for it.
 *
 * The Lab Config screen used to be a list of rows an Ops head had typed in by
 * hand, which meant the lab id had to be copied from LabStack correctly and a
 * lab nobody had gotten round to configuring was simply invisible. The source
 * system already knows the labs, so this reads them from there and LEFT JOINs
 * our own config onto them: the screen becomes a roster of every lab, marked
 * configured or not, rather than a list of what somebody remembered to add.
 *
 * Kept separate from GET /api/non-api-labs, which still returns configured labs
 * only — the message-flow editor builds its provider picker from that and has
 * no use for labs it cannot message.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { suggestGroup } from "@/lib/non-api-labs/group-match";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

type SourceLab = {
  id: number;
  labName: string;
  city: string | null;
  isActive: boolean;
  openOrders: number;
};

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    // Open order count comes along because it is the number that tells an Ops
    // head which unconfigured lab actually matters.
    const [sourceLabs, configs, groups] = await Promise.all([
      labstackWorkerQuery<SourceLab>(`
        SELECT l.id,
               l."labName",
               l.city,
               l."isActive",
               COUNT(o.id) FILTER (
                 WHERE o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
               )::int AS "openOrders"
          FROM public."Lab" l
          LEFT JOIN public."Order" o ON o."labId" = l.id
         GROUP BY l.id, l."labName", l.city, l."isActive"
         ORDER BY l."labName" ASC
      `),
      prisma.nonApiLabConfig.findMany(),
      // Every group the gateway can actually see. This is what makes the
      // WhatsApp target selectable instead of typed.
      prisma.waGroup.findMany({
        select: { jid: true, subject: true, sendEnabled: true, active: true, labId: true },
        orderBy: { subject: "asc" },
      }),
    ]);

    const configByLabId = new Map(configs.map((config) => [config.labId, config]));
    const groupByJid = new Map(groups.map((group) => [group.jid, group]));

    const labs = sourceLabs.map((lab) => {
      const config = configByLabId.get(lab.id) ?? null;
      const suggestion = suggestGroup(lab.labName, groups);
      return {
        labId: lab.id,
        labName: lab.labName,
        city: lab.city,
        sourceActive: lab.isActive,
        openOrders: lab.openOrders,
        configured: !!config,
        config,
        // Offered when the lab has no group yet, so the jid never has to be typed.
        suggestedGroup: suggestion
          ? { jid: suggestion.group.jid, subject: suggestion.group.subject, score: Number(suggestion.score.toFixed(2)) }
          : null,
        // The configured jid corresponds to no group the gateway has ever seen.
        // Almost always a typo, and otherwise invisible: a malformed jid saves
        // happily and then silently fails to deliver.
        unknownGroup: !!config?.waGroupJid && !groupByJid.has(config.waGroupJid),
      };
    });

    // A config whose lab has vanished from LabStack would otherwise disappear
    // from this screen while still driving messages, so surface it too.
    const sourceIds = new Set(sourceLabs.map((lab) => lab.id));
    const orphaned = configs
      .filter((config) => !sourceIds.has(config.labId))
      .map((config) => ({
        labId: config.labId,
        labName: config.labName,
        city: null,
        sourceActive: false,
        openOrders: 0,
        configured: true,
        orphaned: true,
        config,
        suggestedGroup: null,
        unknownGroup: false,
      }));

    // groups ships alongside so the editor can offer a picker.
    return NextResponse.json({ labs: [...labs, ...orphaned], groups });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "NonApiLabsCatalogAPI.GET",
        code: "FETCH_ERROR",
        userMessage: "Failed to load the lab catalogue",
        error,
      }),
      { status: 500 },
    );
  }
}
