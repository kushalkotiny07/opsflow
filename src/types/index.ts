import { UserRole, TaskStatus, TaskPriority, AlertType } from "@prisma/client";

export type { UserRole, TaskStatus, TaskPriority, AlertType };

// ── Labstack Order Status Enum ────────────────────────────────────
// These are the valid Labstack order statuses (source of truth from Labstack schema)
export enum LabstackOrderStatus {
  ORDER_SCHEDULED = "ORDER_SCHEDULED",
  PHLEBO_ASSIGNED = "PHLEBO_ASSIGNED",
  SAMPLE_COLLECTED = "SAMPLE_COLLECTED",
  SAMPLE_DELIVERED = "SAMPLE_DELIVERED",
  SAMPLE_IN_TRANSIT = "SAMPLE_IN_TRANSIT",
  REPORT_READY = "REPORT_READY",
  REPORT_DELIVERED = "REPORT_DELIVERED",
  CANCELED = "CANCELED",
  PATIENT_MISSED = "PATIENT_MISSED",
}

// Validation helper for trigger condition statuses
export function validateTriggerConditionStatuses(
  statusIn: string[]
): { valid: boolean; invalidStatuses?: string[] } {
  const validStatuses = Object.values(LabstackOrderStatus);
  const invalid = statusIn.filter(s => !validStatuses.includes(s as any));

  if (invalid.length > 0) {
    return { valid: false, invalidStatuses: invalid };
  }
  return { valid: true };
}

// Helper to get valid status list
export function getValidOrderStatuses(): string[] {
  return Object.values(LabstackOrderStatus);
}

// ── Auth ──────────────────────────────────────────────────────────
export interface JwtPayload {
  userId: number;
  email: string;
  role: UserRole;
  name: string;
}

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: UserRole; // EFFECTIVE role for authorization — OPS_ADMIN is coerced to OPS_HEAD here
  realRole?: UserRole; // the actual DB role, for display/labelling (e.g. "Ops Admin")
  teamMemberId?: number;
  storeIds?: number[];
}

// ── Labstack read models (read-only from labstack public schema) ──
export interface LabstackOrder {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date;
  storeId: number | null;
  labId: number | null;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
  statusUpdatedAt: Date;
  internalNotes: string;
  notes: string;
  phleboName: string;
  phleboNumber: string;
  // joined fields
  patientName?: string;
  labName?: string;
  storeName?: string;
  // metadata for rule evaluation (P2)
  metadata?: Record<string, any>;
}

// ── Task Rules - Metadata Support (Phase 2) ──────────────────────
// Metadata operators for filtering order metadata fields
export type MetadataOperator =
  | "exists"              // Field exists (any value)
  | "not_exists"          // Field doesn't exist
  | "equals"              // Value equals
  | "not_equals"          // Value doesn't equal
  | "contains"            // String contains substring
  | "starts_with"         // String starts with
  | "ends_with"           // String ends with
  | ">"                   // Greater than (numeric/date)
  | ">="                  // Greater or equal (numeric/date)
  | "<"                   // Less than (numeric/date)
  | "<=";                 // Less or equal (numeric/date)

// Metadata condition for rule trigger evaluation
export interface MetadataCondition {
  fieldPath: string;            // e.g., "reportETA", "patientPhone", "internalNotes"
  operator: MetadataOperator;
  value?: any;                  // Value to compare against
  offsetMinutes?: number;       // For timestamp comparisons with offset
}

// ── Task engine ───────────────────────────────────────────────────
export interface TriggerCondition {
  statusIn: string[];
  minutesSinceCreated?: number;
  minutesSinceStatusUpdated?: number;
  minutesBeforeAppointment?: number;
  minutesAfterAppointment?: number;
  requiresNoPreviousTaskOfType?: boolean;
  // NEW: Metadata-based conditions (Phase 2)
  metadataConditions?: MetadataCondition[];
}

export interface TaskRuleWithRelations {
  id: string;
  name: string;
  dataSourceId: string;
  allowedTypes: string[];
  allowedStatuses: string[];
  pollingIntervalMinutes: number;
  taskTypeId: number;
  titleTemplate: string;
  slaMinutes: number;
  priority: TaskPriority;
  triggerType: "STATUS" | "TIME";
  triggerCondition: TriggerCondition;
  isActive: boolean;
  escalationChainId: number | null;
  // Rule-scoped next-step guidance (overrides the task type's default).
  nextStepComplete?: string | null;
  nextStepIncomplete?: string | null;
  requiredSkills: { skillTagId: number; skillTag: { name: string } }[];
  // Rule's OWN checklist (rule-scoped rows); empty ⇒ use the task-type default.
  checklist: { stepOrder: number; stepText: string; isRequired: boolean; guidance?: string | null; script?: string | null }[];
  taskType: {
    name: string;
    label: string;
    nextStepComplete?: string | null;
    nextStepIncomplete?: string | null;
    checklistItems: { stepOrder: number; stepText: string; isRequired: boolean; guidance?: string | null; script?: string | null }[];
  };
}

export interface CreateTaskPayload {
  taskRuleId: string;
  taskTypeId: number;
  title: string;
  entityType: string;
  entityId: number;
  storeId: number | null;
  orderType: string;
  dataSourceId: string;
  // W4.2 — passed through from rule.assignmentStrategy so pickAssignee
  // can branch on it. Omitted ⇒ "default" (least-loaded with RR tiebreaker).
  assignmentStrategy?: "default" | "round_robin" | "store_affinity" | "skill_based" | "least_loaded";
  priority: TaskPriority;
  slaDeadline: Date;
  // Source order's scheduled time, propagated onto the Task row so all
  // downstream sorting/bucketing (today/tomorrow/stuck) can use it without
  // digging through `metadata`. Null when the source has no scheduled time
  // (e.g. walk-in orders, some pharmacy deliveries).
  appointmentTime: Date | null;
  metadata: Record<string, unknown>;
  checklistSteps: { stepOrder: number; stepText: string; isRequired: boolean; guidance?: string | null; script?: string | null }[];
}

// ── Dashboard types ───────────────────────────────────────────────
export interface RiskItem {
  taskId: number;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  entityId: number;
  orderType: string;
  storeId: number | null;
  slaDeadline: Date;
  slaBreachedAt: Date | null;
  assignedTo: { id: number; name: string } | null;
  metadata: Record<string, unknown>;
  minutesRemaining: number; // negative = overdue
}

export interface TeamMemberStatus {
  userId: number;
  name: string;
  role: UserRole;
  rosterStatus: string;
  openTasks: number;
  maxTasks: number;
  slaComplianceToday: number;
  storeIds: number[];
}

// ── Teams Feature: Data Source Capabilities ──────────────────────────
export interface TeamMemberCapability {
  id?: number;
  teamMemberId: number;
  dataSourceId: string;
  dataSource?: { id: string; sourceId: string; displayName: string };
  assignedAt: Date;
  assignedBy?: number;
}

export interface TeamMemberWithOrderTypes {
  id: number;
  userId: number;
  name: string;
  email: string;
  role: UserRole;
  storeId: number;
  storeName?: string;
  maxConcurrentTasks: number;
  isActive: boolean;
  createdAt: Date;
  capabilities: TeamMemberCapability[];
  capabilityCount: number;
  skills: Array<{ id: number; name: string; label: string }>;
  skillCount: number;
  stores: number[];
  storeCount: number;
  currentLoad: number;
  taskStats: {
    thisMonth: {
      assigned: number;
      completed: number;
      slaCompliance: number;
    };
    thisWeek: {
      assigned: number;
      completed: number;
      slaCompliance: number;
    };
  };
  rosterStatus: string;
  rosterUpdatedAt?: Date;
}

export interface MemberPerformanceStats {
  teamMemberId: number;
  memberName: string;
  period: "week" | "month" | "alltime";
  tasksAssigned: number;
  tasksCompleted: number;
  tasksCancelled: number;
  slaBreaches: number;
  slaCompliancePercent: number;
  avgCompletionTimeMinutes: number;
  avgCompletionTimeHours?: string;
  completionRate: number;
}

export interface OrderTypeOption {
  id: number;
  name: string;
  label: string;
  description: string;
}

export interface DashboardStats {
  activeOrders: number;
  openTasks: number;
  breachedTasks: number;
  warningTasks: number;
  slaHealthPercent: number;
  unassignedTasks: number;
}
