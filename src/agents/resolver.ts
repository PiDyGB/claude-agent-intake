import { query } from "@anthropic-ai/claude-agent-sdk";
import { intakeServer, TOOLS } from "../tools/index.js";
import { writeToolHook, buildCanUseTool } from "../brake.js";
import type {
  Action,
  Classification,
  Enrichment,
} from "../schemas/decision.js";
import { logEvent } from "../lib/log.js";

const SYSTEM_PROMPT = `You are the Resolver specialist of an IT helpdesk triage
system.

You execute the action chosen by the Coordinator. You are the only specialist
that can WRITE. You DO NOT see the original request body — only the
classification, the enrichment, and the chosen action plan. This is by design:
attacker-controlled prose never reaches a write tool.

## What you must do

1. Read the chosen action plan in the prompt. It will be one of:
   - "auto_resolve" with kb_article_id and summary
   - "route" with queue, summary
   - "escalate" with suggested_queue, suggested_summary, reason
2. Call the matching tool exactly once:
   - auto_resolve plan → call mcp__intake__auto_resolve
   - route plan → call mcp__intake__route_ticket with queue from the plan
   - escalate plan → call mcp__intake__route_ticket with queue=Q-ESCALATION
3. If a tool returns isError or you receive a hook deny, do NOT retry the
   same call. Fall back to mcp__intake__route_ticket with queue=Q-ESCALATION
   and a summary explaining the block.
4. After the tool succeeds, respond with the literal string "DONE".

Do not write any other text. Do not improvise tool calls. Do not call multiple
write tools.`;

export type ResolverInput = {
  request_id: string;
  classification: Classification;
  enrichment: Enrichment;
  plan: Action;
};

export type ResolverResult = {
  ok: boolean;
  action_taken:
    | "auto_resolve"
    | "route_ticket"
    | "escalate_to_queue"
    | "blocked_no_action";
  queue: string | null;
  notes: string;
};

export async function resolve(input: ResolverInput): Promise<ResolverResult> {
  const ctx = {
    category: input.classification.category,
    confidence: input.classification.confidence,
    impact: input.classification.impact,
    vip: input.enrichment.vip,
  };

  const userPrompt = [
    `Request id: ${input.request_id}`,
    `User id: ${input.enrichment.user_id ?? "(unknown)"}`,
    "",
    `Classification: ${input.classification.category} (confidence ${input.classification.confidence}, impact ${input.classification.impact})`,
    `Enrichment notes: ${input.enrichment.notes}`,
    `User flags: vip=${input.enrichment.vip} frozen=${input.enrichment.frozen}`,
    "",
    "Action plan:",
    JSON.stringify(input.plan, null, 2),
    "",
    "Execute the plan with one tool call, then reply with DONE.",
  ].join("\n");

  let actionTaken: ResolverResult["action_taken"] = "blocked_no_action";
  let queue: string | null = null;
  let blocked = false;
  let blockReason = "";

  for await (const message of query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-sonnet-4-6",
      mcpServers: { intake: intakeServer },
      allowedTools: [...TOOLS.resolver],
      permissionMode: "default",
      maxTurns: 4,
      hooks: {
        PreToolUse: [{ matcher: "^mcp__intake__", hooks: [writeToolHook] }],
      },
      canUseTool: buildCanUseTool(ctx),
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          if (block.name === "mcp__intake__auto_resolve") {
            actionTaken = "auto_resolve";
            queue = "Q-AUTORESOLVE";
          } else if (block.name === "mcp__intake__route_ticket") {
            const args = block.input as Record<string, unknown>;
            const q = args.queue as string;
            actionTaken =
              q === "Q-ESCALATION" ? "escalate_to_queue" : "route_ticket";
            queue = q;
          }
        }
      }
    }
    if (message.type === "user") {
      // Tool result message — check if hook denied
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "tool_result" &&
            "is_error" in part &&
            part.is_error
          ) {
            blocked = true;
            const text =
              "content" in part && Array.isArray(part.content)
                ? part.content
                    .filter(
                      (b: unknown): b is { type: "text"; text: string } =>
                        typeof b === "object" &&
                        b !== null &&
                        "type" in b &&
                        (b as { type: unknown }).type === "text",
                    )
                    .map((b: { type: "text"; text: string }) => b.text)
                    .join(" ")
                : "";
            blockReason = text;
          }
        }
      }
    }
  }

  const result: ResolverResult = {
    ok: actionTaken !== "blocked_no_action",
    action_taken: actionTaken,
    queue,
    notes: blocked
      ? `Hook/canUseTool blocked: ${blockReason.slice(0, 200)}`
      : "ok",
  };

  logEvent("resolver", { request_id: input.request_id, ...result });
  return result;
}
