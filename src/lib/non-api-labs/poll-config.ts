/**
 * The poll a provider answers with — shared by server and browser.
 *
 * Deliberately its own module with NO imports. These constants are needed both
 * by the scheduler (which builds the outbound row) and by the message-flow
 * editor, and that editor is a "use client" component: importing them from
 * ./templates would drag `@/lib/db/client` — Prisma — into the browser bundle.
 *
 * The label is also a wire format. A WhatsApp poll vote comes back as the
 * option's TEXT rather than its index, so this array is what turns
 * "Cannot fulfil" into REJECT. Relabelling an option changes how FUTURE votes
 * are read; polls already sitting in a provider's group keep their own copy of
 * this list on their WaPoll row, so old polls stay readable.
 */
export type ProviderPollAction = "ACCEPT" | "RESCHEDULE" | "REJECT";

export type ProviderPollOption = {
  label: string;
  action: ProviderPollAction;
};

export const PROVIDER_POLL_NAME = "Can you fulfil this order?";

export const PROVIDER_POLL_OPTIONS = [
  { label: "Accept", action: "ACCEPT" },
  { label: "Reschedule", action: "RESCHEDULE" },
  { label: "Cannot fulfil", action: "REJECT" },
] as const satisfies ReadonlyArray<ProviderPollOption>;
