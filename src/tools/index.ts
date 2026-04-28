import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { findUser, getKBById, searchKB } from "../lib/store.js";
import { logEvent } from "../lib/log.js";
import { CategorySchema, QueueSchema, ImpactSchema } from "../schemas/decision.js";

/**
 * Each tool description includes:
 *   - what the tool DOES
 *   - what it does NOT do
 *   - input format hints
 *   - example queries / edge cases
 *
 * Errors are returned as { isError: true } with a reason code so the agent can
 * recover. Throwing would abort the whole loop.
 */

// ─── Classifier specialist tools ─────────────────────────────────────────

const searchKbTool = tool(
  "search_kb",
  [
    "Search the IT helpdesk knowledge base by free-text query. Returns up to 5",
    "matching articles with id, title, tags, category, summary, and a flag",
    "indicating whether the article describes an auto-resolvable workflow.",
    "",
    "USE WHEN: classifying a request, looking for the canonical article that",
    "describes the user's symptom, or checking whether a category is in the",
    "auto-resolvable set.",
    "",
    "DOES NOT: fetch the full article body verbatim (use `get_kb_article` if",
    "you need full content), invoke any workflow, or update any record.",
    "",
    "INPUT: a short natural-language query of symptoms or keywords. Avoid",
    "stop-words. Example queries: 'forgot password active directory',",
    "'vpn fails after firmware update', 'replica lag production'.",
  ].join(" "),
  {
    query: z
      .string()
      .min(3)
      .max(200)
      .describe("Symptom keywords. Short, no stop-words."),
  },
  async (args) => {
    const hits = searchKB(args.query);
    if (hits.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reason_code: "no_match",
              guidance:
                "No KB articles matched. Try broader terms or set category to 'unknown'.",
              query: args.query,
            }),
          },
        ],
        isError: true,
      };
    }
    const compact = hits.map((a) => ({
      id: a.id,
      title: a.title,
      tags: a.tags,
      category: a.category,
      summary: a.content.slice(0, 160),
      auto_resolvable: a.auto_resolvable,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
    };
  },
);

const getKbArticleTool = tool(
  "get_kb_article",
  [
    "Fetch the full content of one knowledge base article by id (e.g. 'KB-001').",
    "",
    "USE WHEN: search_kb returned a candidate and you need the full text or the",
    "auto_resolution_steps to plan a resolve action.",
    "",
    "DOES NOT: search by free text — use `search_kb` for that. Does not modify",
    "the KB or any ticket.",
    "",
    "INPUT: an exact article id of the form 'KB-NNN'.",
  ].join(" "),
  {
    id: z
      .string()
      .regex(/^KB-\d{3}$/i)
      .describe("Exact article id, e.g. KB-001"),
  },
  async (args) => {
    const a = getKBById(args.id.toUpperCase());
    if (!a) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reason_code: "not_found",
              guidance: "Article id does not exist. Use search_kb first.",
              id: args.id,
            }),
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
  },
);

// ─── Enricher specialist tools ───────────────────────────────────────────

const lookupUserTool = tool(
  "lookup_user",
  [
    "Look up a user record from the system of record by id ('U001') or email.",
    "Returns id, name, department, manager, status, mfa_enrolled, frozen,",
    "frozen_reason (if any), vip flag.",
    "",
    "USE WHEN: enriching a request to apply escalation rules. The frozen flag",
    "and the vip flag are load-bearing for routing decisions.",
    "",
    "DOES NOT: change any user attribute. Does not search by free text — use",
    "the exact id or email. Does not infer identity from a display name.",
    "",
    "INPUT: 'U001' style id, or full email address. If the request only",
    "contains a display name, return reason_code='ambiguous_identity'.",
  ].join(" "),
  {
    id_or_email: z
      .string()
      .min(3)
      .max(200)
      .describe("User id (e.g. 'U001') or email address. Not a display name."),
  },
  async (args) => {
    if (!/^U\d{3}$/i.test(args.id_or_email) && !/@/.test(args.id_or_email)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reason_code: "ambiguous_identity",
              guidance:
                "Need an id or email. Free-text names are not resolvable here.",
              given: args.id_or_email,
            }),
          },
        ],
        isError: true,
      };
    }
    const u = findUser(args.id_or_email);
    if (!u) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reason_code: "user_not_found",
              guidance: "User does not exist in directory. Treat as unknown.",
              given: args.id_or_email,
            }),
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(u, null, 2) }] };
  },
);

const readTicketHistoryTool = tool(
  "read_ticket_history",
  [
    "Read the count of recent open tickets associated with a user, by user id.",
    "Returns { user_id, prior_open_tickets }. Used to detect repeat issues that",
    "should escalate even when the current request looks routine.",
    "",
    "DOES NOT: return ticket bodies (privacy). Does not write or close tickets.",
    "",
    "INPUT: a user id of the form 'U001'. Returns 0 if the user is unknown.",
  ].join(" "),
  {
    user_id: z
      .string()
      .regex(/^U\d{3}$/i)
      .describe("User id, e.g. 'U001'"),
  },
  async (args) => {
    // Deterministic mock: 0 for everyone, 2 for U002 (Bob, the repeat case).
    const count = args.user_id.toUpperCase() === "U002" ? 2 : 0;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ user_id: args.user_id, prior_open_tickets: count }),
        },
      ],
    };
  },
);

// ─── Resolver specialist tools (write surface, gated by hooks) ───────────

const autoResolveTool = tool(
  "auto_resolve",
  [
    "Auto-resolve a request using a known-safe knowledge base article. Closes",
    "the ticket and writes to the Q-AUTORESOLVE queue. This is one of TWO",
    "write tools and it has the smallest blast radius.",
    "",
    "USE WHEN: the Mandate's auto-resolve preconditions hold (auto_resolvable",
    "KB hit, confidence >= 0.85, low impact, user not frozen, user not vip).",
    "",
    "DOES NOT: handle MFA resets, frozen accounts, P1 incidents, phishing, or",
    "anything not flagged auto_resolvable in the KB. The PreToolUse hook will",
    "hard-deny if a frozen account or a known-bad pattern is detected;",
    "if denied, do NOT retry — call route_ticket with queue=Q-ESCALATION.",
    "",
    "INPUT: request_id, kb_article_id, user_id, summary (what was done).",
  ].join(" "),
  {
    request_id: z.string().min(1).describe("The inbound request id."),
    kb_article_id: z
      .string()
      .regex(/^KB-\d{3}$/i)
      .describe("Article that authorizes the auto-resolution."),
    user_id: z
      .string()
      .regex(/^U\d{3}$/i)
      .describe("Affected user id."),
    summary: z
      .string()
      .min(10)
      .max(300)
      .describe("One sentence on what action was taken."),
  },
  async (args) => {
    logEvent("actions", { kind: "auto_resolve", ...args });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            queue: "Q-AUTORESOLVE",
            request_id: args.request_id,
          }),
        },
      ],
    };
  },
);

const routeTicketTool = tool(
  "route_ticket",
  [
    "Route a ticket to a queue. This is the primary write tool. Use queue",
    "Q-ESCALATION for human-in-the-loop review (escalation rules from the",
    "Mandate). Use a domain queue (Q-IDENTITY, Q-NETWORK, Q-WORKSTATION,",
    "Q-INFRA, Q-SECURITY, Q-PROCUREMENT) for normal routing.",
    "",
    "USE WHEN: the request is not auto-resolvable, or auto-resolve was denied.",
    "Always callable as a fallback.",
    "",
    "DOES NOT: send messages to the user, ping anyone, or close the ticket. It",
    "only changes the queue assignment.",
    "",
    "INPUT: request_id, queue (one of the closed set), summary, category,",
    "confidence, impact. The PreToolUse hook validates against frozen accounts",
    "and against routing CEO/exec mentions to non-Security queues.",
  ].join(" "),
  {
    request_id: z.string().min(1),
    queue: QueueSchema,
    category: CategorySchema,
    confidence: z.number().min(0).max(1),
    impact: ImpactSchema,
    summary: z.string().min(10).max(300),
    user_id: z.string().nullable(),
  },
  async (args) => {
    logEvent("actions", { kind: "route_ticket", ...args });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            queue: args.queue,
            request_id: args.request_id,
          }),
        },
      ],
    };
  },
);

// ─── MCP server bundling all tools ───────────────────────────────────────

export const intakeServer = createSdkMcpServer({
  name: "intake",
  version: "0.1.0",
  tools: [
    searchKbTool,
    getKbArticleTool,
    lookupUserTool,
    readTicketHistoryTool,
    autoResolveTool,
    routeTicketTool,
  ],
});

/** Per-specialist tool allowlists (mcp__intake__* qualified names). */
export const TOOLS = {
  classifier: ["mcp__intake__search_kb", "mcp__intake__get_kb_article"],
  enricher: ["mcp__intake__lookup_user", "mcp__intake__read_ticket_history"],
  resolver: ["mcp__intake__auto_resolve", "mcp__intake__route_ticket"],
} as const;

export const WRITE_TOOLS = new Set([
  "mcp__intake__auto_resolve",
  "mcp__intake__route_ticket",
]);
