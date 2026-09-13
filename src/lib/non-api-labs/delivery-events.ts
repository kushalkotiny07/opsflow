export type DeliveryStatus =
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "SUPPRESSED"
  | "ACTION_TAKEN";

export function normalizeDeliveryStatus(value?: string | null): DeliveryStatus | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();

  if (["queued", "pending", "waiting"].includes(normalized)) return "SENT";
  if (["sent", "outbound", "submitted"].includes(normalized)) return "SENT";
  if (["delivered", "received"].includes(normalized)) return "DELIVERED";
  if (["read", "opened", "seen"].includes(normalized)) return "READ";
  if (["failed", "error", "rejected"].includes(normalized)) return "FAILED";
  if (["suppressed", "blocked"].includes(normalized)) return "SUPPRESSED";
  if (["action_taken", "action-taken"].includes(normalized)) return "ACTION_TAKEN";

  return null;
}
