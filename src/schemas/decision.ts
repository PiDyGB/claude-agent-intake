import { z } from "zod";

export const CategorySchema = z.enum([
  "password_reset",
  "mfa_issue",
  "vpn_issue",
  "outlook_issue",
  "software_license",
  "hardware_request",
  "phishing_report",
  "p1_incident",
  "frozen_account_request",
  "vip_request",
  "unknown",
]);
export type Category = z.infer<typeof CategorySchema>;

export const QueueSchema = z.enum([
  "Q-IDENTITY",
  "Q-NETWORK",
  "Q-WORKSTATION",
  "Q-INFRA",
  "Q-SECURITY",
  "Q-PROCUREMENT",
  "Q-AUTORESOLVE",
  "Q-ESCALATION",
]);
export type Queue = z.infer<typeof QueueSchema>;

export const ImpactSchema = z.enum(["low", "medium", "high"]);
export type Impact = z.infer<typeof ImpactSchema>;

export const ClassificationSchema = z.object({
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
  kb_article_ids: z.array(z.string()).max(5),
  impact: ImpactSchema,
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const EnrichmentSchema = z.object({
  user_id: z.string().nullable(),
  user_known: z.boolean(),
  vip: z.boolean(),
  frozen: z.boolean(),
  frozen_reason: z.string().nullable(),
  mfa_enrolled: z.boolean().nullable(),
  prior_open_tickets: z.number().int().min(0),
  notes: z.string().max(500),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("auto_resolve"),
    kb_article_id: z.string(),
    summary: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal("route"),
    queue: QueueSchema,
    summary: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal("escalate"),
    reason: z.string().min(1).max(300),
    suggested_queue: QueueSchema,
    suggested_summary: z.string().min(1).max(300),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  request_id: z.string(),
  classification: ClassificationSchema,
  enrichment: EnrichmentSchema,
  action: ActionSchema,
  reasoning_chain: z.array(z.string()).max(20),
  retry_count: z.number().int().min(0),
  created_at: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const TicketSchema = z.object({
  id: z.string(),
  channel: z.enum(["email", "web_form", "chat"]),
  subject: z.string(),
  body: z.string(),
  from_email: z.string().email().optional(),
  from_user_id: z.string().optional(),
  received_at: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;
