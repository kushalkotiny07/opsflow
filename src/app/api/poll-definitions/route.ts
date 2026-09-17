/**
 * Editable poll definitions — the question, the options, and each option's
 * reply. GET lists them (seeding the shipped ones on first call), PUT saves one.
 *
 * Validation lives here rather than in the client because a malformed
 * definition is not a cosmetic problem: an option whose label is blank cannot
 * be matched when the vote comes back, and a poll with one option cannot be
 * rendered by WhatsApp at all.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { seedPollDefinitions, parsePollOptions, type PollOption } from "@/lib/non-api-labs/poll-definitions";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const ACTIONS = new Set(["ACCEPT", "RESCHEDULE", "REJECT"]);
/** WhatsApp's own limits: 12 options, and a label people can read on a phone. */
const MAX_OPTIONS = 12;
const MAX_LABEL = 100;

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    // Seeding on read means a fresh database shows the shipped polls rather
    // than an empty screen that looks broken.
    await seedPollDefinitions().catch(() => undefined);
    const polls = await prisma.waPollDefinition.findMany({ orderBy: { key: "asc" } });
    return NextResponse.json({ polls });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({ requestId, scope: "PollDefinitionsAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load polls", error }),
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) return NextResponse.json({ error: "key is required", code: "VALIDATION_ERROR", requestId }, { status: 400 });

    const existing = await prisma.waPollDefinition.findUnique({ where: { key } });
    if (!existing) return NextResponse.json({ error: "No such poll", code: "NOT_FOUND", requestId }, { status: 404 });

    const errors: Record<string, string> = {};
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) errors.question = "the poll needs a question";
    if (question.length > 255) errors.question = "keep the question under 255 characters";

    const rawOptions: unknown[] = Array.isArray(body?.options) ? body.options : [];
    const options: PollOption[] = [];
    for (const [index, raw] of rawOptions.entries()) {
      const option = (raw ?? {}) as Record<string, unknown>;
      const label = typeof option.label === "string" ? option.label.trim() : "";
      const ack = typeof option.ack === "string" ? option.ack.trim() : "";
      const action = option.action === null || option.action === "" || option.action === undefined
        ? null
        : String(option.action);

      if (!label) { errors[`option${index}`] = "every option needs a label"; continue; }
      if (label.length > MAX_LABEL) { errors[`option${index}`] = `label must be under ${MAX_LABEL} characters`; continue; }
      if (action !== null && !ACTIONS.has(action)) { errors[`option${index}`] = "action must be Accept, Reschedule, Cannot fulfil, or none"; continue; }
      options.push({ label, action: action as PollOption["action"], ack });
    }

    // A vote comes back as the option TEXT, so duplicates are unresolvable.
    const labels = options.map((option) => option.label.toLowerCase());
    if (new Set(labels).size !== labels.length) errors.options = "two options share a label — a vote could not be matched back";
    if (options.length < 2) errors.options = "a poll needs at least two options";
    if (options.length > MAX_OPTIONS) errors.options = `WhatsApp allows at most ${MAX_OPTIONS} options`;

    if (Object.keys(errors).length) {
      return NextResponse.json({ error: "Invalid poll", code: "VALIDATION_ERROR", requestId, details: errors }, { status: 400 });
    }

    const poll = await prisma.waPollDefinition.update({
      where: { key },
      data: {
        question,
        options,
        name: typeof body?.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
        isActive: typeof body?.isActive === "boolean" ? body.isActive : existing.isActive,
      },
    });
    // Round-trip through the same parser the engine uses, so what the screen
    // shows after saving is what a send would actually resolve.
    return NextResponse.json({ poll: { ...poll, options: parsePollOptions(poll.options) } });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({ requestId, scope: "PollDefinitionsAPI.PUT", code: "UPDATE_ERROR", userMessage: "Failed to save the poll", error }),
      { status: 500 },
    );
  }
}
