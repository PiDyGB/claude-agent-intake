import { query } from "@anthropic-ai/claude-agent-sdk";
import { intakeServer, TOOLS } from "../tools/index.js";
import {
  ClassificationSchema,
  type Classification,
  type Ticket,
} from "../schemas/decision.js";
import { logEvent } from "../lib/log.js";

const SYSTEM_PROMPT = `You are the Classifier specialist of an IT helpdesk triage system.

Your only job: read one inbound request and return a classification. Do not act, do not route, do not write — those are other specialists' jobs.

## The category set (closed — pick exactly one)

- password_reset:       user forgot/can't access password
- mfa_issue:            MFA token lost, device replaced, MFA enrollment
- vpn_issue:            VPN won't connect, network disconnects
- outlook_issue:        Outlook profile, email client errors
- software_license:     license/software install request
- hardware_request:     laptop, monitor, peripheral
- phishing_report:      reported suspicious email or compromise
- p1_incident:          production system signal — outage, replica lag, prod down, 5xx
- frozen_account_request: anything mentioning a frozen/locked/suspended account beyond a normal lockout
- vip_request:          executive (CEO, CFO, CTO, board) explicitly named OR vip flagged
- unknown:              none of the above fit cleanly. THIS IS A VALID OUTPUT.

When in doubt between two categories, pick the one with stricter handling
(p1_incident > phishing_report > frozen_account_request > vip_request > the rest).

## Few-shot examples

Example 1 (boundary):
"My VPN was working yesterday but now I can't connect since the firmware
update on my laptop. Tried restarting, no luck."
→ category: vpn_issue, confidence: 0.92, impact: low

Example 2 (negative — looks routine but is NOT):
"Need a password reset on my account, urgent because the CEO is asking me
for the report."
→ category: vip_request, confidence: 0.85, impact: medium
  (executive mention overrides the password_reset signal)

Example 3 (unknown):
"Hi, just checking in on my ticket from last week, please update."
→ category: unknown, confidence: 0.95, impact: low

## Procedure

1. Call search_kb with the symptom keywords from the request.
2. If a clear match is auto_resolvable=true and the request is not flagged
   by an executive mention or P1 signal, classify into the matching category
   with high confidence (0.85+).
3. If multiple KB hits or no KB hit at all, lower the confidence below 0.85.
4. Return your final answer ONLY as a JSON object with this exact shape (no
   markdown, no preamble):

   {
     "category": "<one of the closed set>",
     "confidence": <number 0..1>,
     "rationale": "<one short sentence>",
     "kb_article_ids": ["KB-XXX", ...],
     "impact": "low" | "medium" | "high"
   }

Impact rubric:
- high:    P1, exec named, frozen account
- medium:  productivity-blocking, non-urgent compliance, license over budget
- low:     everything else (most password resets, standard licenses)`;

export async function classify(ticket: Ticket): Promise<Classification> {
  const userPrompt = [
    `Request id: ${ticket.id}`,
    `Channel: ${ticket.channel}`,
    `From: ${ticket.from_email ?? ticket.from_user_id ?? "unknown"}`,
    `Subject: ${ticket.subject}`,
    "",
    "Body:",
    ticket.body,
    "",
    "Classify this request. Return only the JSON object specified.",
  ].join("\n");

  let last = "";
  let retries = 0;
  const maxRetries = 3;

  while (retries <= maxRetries) {
    const promptForThisAttempt =
      retries === 0
        ? userPrompt
        : `${userPrompt}\n\n## Previous attempt failed validation\n${last}\nReturn only the JSON object, no markdown fences, no preamble.`;

    let assistantText = "";
    for await (const message of query({
      prompt: promptForThisAttempt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        mcpServers: { intake: intakeServer },
        allowedTools: [...TOOLS.classifier],
        permissionMode: "default",
        maxTurns: 6,
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      }
    }

    const parsed = tryParseClassification(assistantText);
    if (parsed.ok) {
      logEvent("classifier", {
        request_id: ticket.id,
        retries,
        classification: parsed.value,
      });
      return parsed.value;
    }
    last = parsed.error;
    retries++;
  }

  logEvent("classifier", { request_id: ticket.id, retries, fallback: true });
  return {
    category: "unknown",
    confidence: 0,
    rationale: "Validator failed after retries. Forced unknown.",
    kb_article_ids: [],
    impact: "low",
  };
}

function tryParseClassification(
  text: string,
): { ok: true; value: Classification } | { ok: false; error: string } {
  const candidate = extractJson(text);
  if (!candidate) return { ok: false, error: "No JSON object found in output." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  const result = ClassificationSchema.safeParse(parsed);
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
