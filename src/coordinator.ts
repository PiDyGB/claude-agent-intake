import { classify } from "./agents/classifier.js";
import { enrich } from "./agents/enricher.js";
import { resolve, type ResolverResult } from "./agents/resolver.js";
import { shouldEscalate, detectInjection } from "./brake.js";
import {
  type Action,
  type Decision,
  type Ticket,
} from "./schemas/decision.js";
import { getKBById } from "./lib/store.js";
import { logEvent } from "./lib/log.js";

/**
 * The coordinator is plain TypeScript — no LLM in the loop. It is the
 * auditable glue between three LLM specialists:
 *   classify  → enrich  → plan  → resolve
 *
 * The plan step is also deterministic: it consults the escalation rules and
 * the KB whitelist to decide between auto_resolve / route / escalate. The
 * Resolver subagent only carries the plan out.
 */
export async function triage(ticket: Ticket): Promise<Decision & { result: ResolverResult }> {
  const reasoning: string[] = [];
  reasoning.push(`Received request ${ticket.id} from channel ${ticket.channel}.`);

  // Pre-classification: detect injection in the inbound body. Logged for
  // visibility; the classifier still gets the original body but the resolver
  // never will.
  const injection = detectInjection(`${ticket.subject}\n${ticket.body}`);
  if (injection.length > 0) {
    reasoning.push(
      `Pre-flight injection scan flagged: ${injection.map((h) => h.kind).join(",")}.`,
    );
    logEvent("injection_signal", { request_id: ticket.id, injection });
  }

  // Step 1: classify
  const classification = await classify(ticket);
  reasoning.push(
    `Classifier → ${classification.category} (conf ${classification.confidence.toFixed(2)}, impact ${classification.impact}).`,
  );

  // Step 2: enrich (only the user identifier is passed; not the body)
  const identifier = ticket.from_user_id ?? ticket.from_email ?? null;
  const enrichment = await enrich(identifier, classification, ticket.id);
  reasoning.push(
    `Enricher → user_known=${enrichment.user_known} vip=${enrichment.vip} frozen=${enrichment.frozen}.`,
  );

  // Step 3: deterministic plan
  const plan = chooseAction(classification, enrichment, injection.length > 0);
  reasoning.push(`Plan: ${plan.kind}${"queue" in plan ? ` → ${plan.queue}` : ""}.`);

  // Step 4: resolver subagent carries the plan out
  const result = await resolve({
    request_id: ticket.id,
    classification,
    enrichment,
    plan,
  });
  reasoning.push(
    `Resolver → ${result.action_taken}${result.queue ? " (" + result.queue + ")" : ""}; ${result.notes}`,
  );

  const decision: Decision = {
    request_id: ticket.id,
    classification,
    enrichment,
    action: plan,
    reasoning_chain: reasoning,
    retry_count: 0, // per-step retry counts already logged in their own streams
    created_at: new Date().toISOString(),
  };

  logEvent("decisions", { decision, result });
  return { ...decision, result };
}

/**
 * Deterministic action picker. The coordinator decides; the resolver acts.
 * This is where the Mandate's escalation rules become code.
 */
function chooseAction(
  classification: ReturnType<typeof classify> extends Promise<infer C> ? C : never,
  enrichment: ReturnType<typeof enrich> extends Promise<infer E> ? E : never,
  injectionDetected: boolean,
): Action {
  // Hard escalations first.
  if (enrichment.frozen) {
    return {
      kind: "escalate",
      reason: `Frozen account: ${enrichment.frozen_reason ?? "unspecified"}`,
      suggested_queue: "Q-ESCALATION",
      suggested_summary:
        `Frozen account flagged on classification ${classification.category}. Manual review required.`.slice(
          0,
          300,
        ),
    };
  }

  if (injectionDetected) {
    return {
      kind: "escalate",
      reason: "Prompt-injection signal in inbound body.",
      suggested_queue: "Q-ESCALATION",
      suggested_summary:
        `Suspicious instructions in body. Classified as ${classification.category}, sent for manual review.`.slice(
          0,
          300,
        ),
    };
  }

  const escalation = shouldEscalate({
    category: classification.category,
    confidence: classification.confidence,
    impact: classification.impact,
    vip: enrichment.vip,
  });

  if (escalation) {
    return {
      kind: "escalate",
      reason: escalation,
      suggested_queue: suggestedQueueFor(classification.category),
      suggested_summary: classification.rationale.slice(0, 300),
    };
  }

  // Auto-resolve gate: KB whitelist + auto_resolvable flag + impact low.
  const kbId = classification.kb_article_ids[0];
  if (kbId) {
    const kb = getKBById(kbId);
    if (
      kb?.auto_resolvable &&
      classification.confidence >= 0.85 &&
      classification.impact === "low"
    ) {
      return {
        kind: "auto_resolve",
        kb_article_id: kbId,
        summary: `Auto-resolved per ${kbId}: ${classification.rationale}`.slice(0, 300),
      };
    }
  }

  // Plain route to the domain queue.
  return {
    kind: "route",
    queue: suggestedQueueFor(classification.category),
    summary: classification.rationale.slice(0, 300),
  };
}

function suggestedQueueFor(category: string): Action extends { kind: "route"; queue: infer Q } ? Q : never {
  switch (category) {
    case "password_reset":
    case "mfa_issue":
    case "frozen_account_request":
      return "Q-IDENTITY" as never;
    case "vpn_issue":
      return "Q-NETWORK" as never;
    case "outlook_issue":
    case "hardware_request":
      return "Q-WORKSTATION" as never;
    case "p1_incident":
      return "Q-INFRA" as never;
    case "phishing_report":
      return "Q-SECURITY" as never;
    case "software_license":
      return "Q-PROCUREMENT" as never;
    case "vip_request":
    case "unknown":
    default:
      return "Q-ESCALATION" as never;
  }
}
