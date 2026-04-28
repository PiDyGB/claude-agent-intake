import type {
  HookCallback,
  PreToolUseHookInput,
  CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { findUser } from "./lib/store.js";
import { logEvent } from "./lib/log.js";
import type { Category, Impact } from "./schemas/decision.js";

// ─── Pattern detectors (pure, deterministic) ─────────────────────────────

/** Strings that suggest the request body contains agent-targeted instructions. */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:prior|previous|above|preceding) instructions?/i,
  /disregard (?:all )?(?:prior|previous|above|preceding) instructions?/i,
  /you are now/i,
  /system\s*:\s*/i,
  /\bact as (?:an?|the) (?:admin|administrator|root|superuser)/i,
  /override (?:the )?safety/i,
  /reveal your (?:system )?prompt/i,
  /\broute (?:this )?to (?:the )?ceo\b/i,
  /\bauto[- ]?resolve (?:this|all|everything)\b/i,
];

const EXEC_MENTIONS = /\b(ceo|cfo|cto|coo|board|chief executive)\b/i;

/** PII patterns we never want to see leaving the agent in a write call. */
const PII_PATTERNS: { name: string; rx: RegExp }[] = [
  { name: "ssn", rx: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "credit_card", rx: /\b(?:\d[ -]?){13,16}\b/ },
  { name: "iban", rx: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i },
];

export type PatternHit = { kind: string; detail: string };

export function detectInjection(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const rx of PROMPT_INJECTION_PATTERNS) {
    const m = text.match(rx);
    if (m) hits.push({ kind: "prompt_injection", detail: m[0] });
  }
  if (EXEC_MENTIONS.test(text)) {
    const m = text.match(EXEC_MENTIONS);
    if (m) hits.push({ kind: "executive_mention", detail: m[0] });
  }
  return hits;
}

export function detectPII(text: string): PatternHit[] {
  return PII_PATTERNS.filter((p) => p.rx.test(text)).map((p) => ({
    kind: `pii_${p.name}`,
    detail: "redacted",
  }));
}

// ─── PreToolUse hook: HARD STOP ──────────────────────────────────────────

/**
 * Deterministic hard stop on the write tools. Runs before canUseTool.
 *   1. Frozen account → deny.
 *   2. PII in summary or anywhere in the tool input → deny.
 *   3. auto_resolve targeting an executive (CEO/CFO/etc) by user_id → deny.
 *   4. route_ticket trying to send a phishing/security signal to a non-Security
 *      queue → deny.
 *   5. route_ticket sending a P1-flagged request anywhere except Q-INFRA or
 *      Q-ESCALATION → deny.
 *
 * Anything not matched falls through to canUseTool.
 */
export const writeToolHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;
  const args = (pre.tool_input ?? {}) as Record<string, unknown>;
  const toolName = pre.tool_name;

  const deny = (reason: string, code: string) => {
    logEvent("hook_deny", { tool: toolName, code, reason, args });
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `${code}: ${reason}`,
      },
      systemMessage: `Hard-stop: ${code}. Do not retry the same call. Use route_ticket with queue=Q-ESCALATION instead.`,
    };
  };

  // 1. frozen account check (any write referencing a frozen user)
  const userId = typeof args.user_id === "string" ? args.user_id : null;
  if (userId) {
    const u = findUser(userId);
    if (u?.frozen) {
      return deny(
        `User ${userId} is frozen (${u.frozen_reason ?? "unspecified"}). No write actions permitted.`,
        "FROZEN_ACCOUNT",
      );
    }
    if (u?.vip && toolName === "mcp__intake__auto_resolve") {
      return deny(
        `User ${userId} is VIP. Auto-resolve is not permitted on VIP accounts.`,
        "VIP_AUTO_RESOLVE",
      );
    }
  }

  // 2. PII in the summary or anywhere stringy in the args
  const haystack = JSON.stringify(args);
  const piiHits = detectPII(haystack);
  if (piiHits.length > 0) {
    return deny(
      `PII detected: ${piiHits.map((h) => h.kind).join(",")}.`,
      "PII_EXFIL",
    );
  }

  // 3. executive mentions in any user-supplied text
  const summary = typeof args.summary === "string" ? args.summary : "";
  const injectionHits = detectInjection(summary);
  if (
    injectionHits.some((h) => h.kind === "executive_mention") &&
    toolName === "mcp__intake__auto_resolve"
  ) {
    return deny(
      "Auto-resolve mentions an executive role. Always escalate.",
      "EXEC_AUTO_RESOLVE",
    );
  }
  if (injectionHits.some((h) => h.kind === "prompt_injection")) {
    return deny(
      "Prompt-injection pattern in tool input.",
      "INJECTION_IN_TOOL_INPUT",
    );
  }

  // 4. phishing/security routes must go to Q-SECURITY or Q-ESCALATION
  if (toolName === "mcp__intake__route_ticket") {
    const category = args.category as Category | undefined;
    const queue = args.queue as string | undefined;
    if (
      category === "phishing_report" &&
      queue !== "Q-SECURITY" &&
      queue !== "Q-ESCALATION"
    ) {
      return deny(
        `Phishing reports must route to Q-SECURITY or Q-ESCALATION, got ${queue}.`,
        "BAD_SECURITY_ROUTE",
      );
    }
    // 5. P1 incidents must go to Q-INFRA or Q-ESCALATION
    if (
      category === "p1_incident" &&
      queue !== "Q-INFRA" &&
      queue !== "Q-ESCALATION"
    ) {
      return deny(
        `P1 incidents must route to Q-INFRA or Q-ESCALATION, got ${queue}.`,
        "BAD_P1_ROUTE",
      );
    }
  }

  // 6. auto_resolve allowed only for password_reset & software_license categories.
  // We don't see the category directly in auto_resolve args, but we have the
  // KB article id; gate on the article id whitelist.
  if (toolName === "mcp__intake__auto_resolve") {
    const kb = (args.kb_article_id as string | undefined)?.toUpperCase();
    const AUTO_RESOLVE_KB_WHITELIST = new Set(["KB-001", "KB-005"]);
    if (!kb || !AUTO_RESOLVE_KB_WHITELIST.has(kb)) {
      return deny(
        `KB article ${kb ?? "(missing)"} is not in the auto-resolve whitelist (only KB-001, KB-005).`,
        "KB_NOT_AUTO_RESOLVABLE",
      );
    }
  }

  return {};
};

// ─── canUseTool: ESCALATION RULES (slow stop) ────────────────────────────

export type EscalationContext = {
  category: Category;
  confidence: number;
  impact: Impact;
  vip: boolean;
};

/**
 * Explicit rules from The Mandate. Returns the escalation reason or null.
 * Category × confidence × impact. No vague "not sure" thresholds.
 */
export function shouldEscalate(ctx: EscalationContext): string | null {
  if (ctx.vip) return "user_vip";
  if (ctx.confidence < 0.7) return "very_low_confidence";
  const ALWAYS_ESCALATE: Category[] = [
    "phishing_report",
    "p1_incident",
    "frozen_account_request",
    "vip_request",
    "mfa_issue",
    "unknown",
  ];
  if (ALWAYS_ESCALATE.includes(ctx.category)) {
    return `category_always_escalates:${ctx.category}`;
  }
  if (ctx.impact === "high") return "impact_high";
  if (ctx.impact === "medium" && ctx.confidence < 0.9) {
    return "medium_impact_low_confidence";
  }
  if (ctx.confidence < 0.85) return "low_confidence_for_action";
  return null;
}

/**
 * Build a canUseTool callback that consults the escalation rules. The hook
 * runs first; if a write tool reaches here, the hook approved. We then apply
 * the escalation rules on auto_resolve only — route_ticket is allowed.
 */
export function buildCanUseTool(ctx: EscalationContext): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "mcp__intake__auto_resolve") {
      const reason = shouldEscalate(ctx);
      if (reason) {
        logEvent("escalation_block", { tool: toolName, reason, ctx, input });
        return {
          behavior: "deny",
          message: `Escalation rule '${reason}' triggered. Do not auto-resolve. Call route_ticket with queue=Q-ESCALATION instead.`,
        };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}
