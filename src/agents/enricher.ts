import { query } from "@anthropic-ai/claude-agent-sdk";
import { intakeServer, TOOLS } from "../tools/index.js";
import {
  EnrichmentSchema,
  type Enrichment,
  type Classification,
} from "../schemas/decision.js";
import { logEvent } from "../lib/log.js";

const SYSTEM_PROMPT = `You are the Enricher specialist of an IT helpdesk triage
system.

Your job: given a user identifier and a category, look up the user record and
return an enrichment payload. You DO NOT see the original request body. You
only see the structured classification. This protects the write surface from
prompt injection.

## Procedure

1. Call lookup_user with the user id or email passed in the prompt.
2. If lookup_user returns reason_code 'user_not_found' or 'ambiguous_identity',
   set user_known=false and stop. Return zeros for the other booleans, null
   for nullable fields, prior_open_tickets=0.
3. If found, also call read_ticket_history with the user id.
4. Return ONLY a JSON object with this shape:

   {
     "user_id": "<U001 or null>",
     "user_known": true|false,
     "vip": true|false,
     "frozen": true|false,
     "frozen_reason": "<string or null>",
     "mfa_enrolled": true|false|null,
     "prior_open_tickets": <integer>,
     "notes": "<one short sentence summarizing material flags>"
   }

No markdown, no preamble.`;

export async function enrich(
  identifier: string | null,
  classification: Classification,
  requestId: string,
): Promise<Enrichment> {
  if (!identifier) {
    return {
      user_id: null,
      user_known: false,
      vip: false,
      frozen: false,
      frozen_reason: null,
      mfa_enrolled: null,
      prior_open_tickets: 0,
      notes: "No identifier supplied.",
    };
  }

  const userPrompt = [
    `Classification: ${classification.category} (confidence ${classification.confidence})`,
    `Identifier to look up: ${identifier}`,
    "",
    "Return only the JSON object specified in the system prompt.",
  ].join("\n");

  let last = "";
  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    const promptForThisAttempt =
      retries === 0
        ? userPrompt
        : `${userPrompt}\n\n## Previous attempt failed validation\n${last}\nReturn only the JSON object.`;

    let assistantText = "";
    for await (const message of query({
      prompt: promptForThisAttempt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        mcpServers: { intake: intakeServer },
        allowedTools: [...TOOLS.enricher],
        permissionMode: "default",
        maxTurns: 5,
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      }
    }

    const parsed = tryParseEnrichment(assistantText);
    if (parsed.ok) {
      logEvent("enricher", { request_id: requestId, retries, enrichment: parsed.value });
      return parsed.value;
    }
    last = parsed.error;
    retries++;
  }

  logEvent("enricher", { request_id: requestId, retries, fallback: true });
  return {
    user_id: null,
    user_known: false,
    vip: false,
    frozen: false,
    frozen_reason: null,
    mfa_enrolled: null,
    prior_open_tickets: 0,
    notes: "Enrichment validation failed after retries.",
  };
}

function tryParseEnrichment(
  text: string,
): { ok: true; value: Enrichment } | { ok: false; error: string } {
  const candidate = extractJson(text);
  if (!candidate) return { ok: false, error: "No JSON object found in output." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  const result = EnrichmentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Schema validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, value: result.data };
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced && fenced[1]) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
