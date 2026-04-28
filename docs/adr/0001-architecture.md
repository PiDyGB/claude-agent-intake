# ADR 0001 — Coordinator + Specialist Subagent Architecture

**Status:** Accepted · **Date:** 2026-04-28 · **Owners:** Architect role · **Supersedes:** —

## Context

We need to triage ~200 daily helpdesk requests with a Claude Agent SDK system that classifies, enriches, routes, and (in two narrow cases) acts. The Mandate sets the boundaries; this ADR describes the runtime shape.

Two competing pulls:

1. **One big agent, lots of tools.** Simpler to write, harder to evolve. Tool-selection reliability drops past ~5 tools per agent (Mandate cites this; SDK docs corroborate). With knowledge lookup + user lookup + ticket read + ticket write + escalate + audit, we are already at the edge.
2. **Coordinator + specialists.** More moving parts, but each specialist gets a focused tool set and a focused prompt. Failure modes are localized; the eval can target the seam where they matter.

We pick (2). The marginal complexity is bought back by tool-selection reliability and by the ability to evaluate sub-decisions independently.

## Decision

A **coordinator agent** that owns the request lifecycle, plus three **specialist subagents** dispatched via the SDK's `Agent` tool with explicit context passing.

### Topology

```
                  ┌──────────────────────────────────┐
  inbound ───────▶│      Coordinator Agent           │
  (request)       │  - parses input                  │
                  │  - calls Classifier (subagent)   │
                  │  - calls Enricher (subagent)     │
                  │  - applies escalation rules      │
                  │  - calls Resolver (subagent)     │
                  │    OR routes to queue            │
                  │  - validates structured output   │
                  │  - logs reasoning chain          │
                  └──────┬───────┬───────┬───────────┘
                         │       │       │
                         ▼       ▼       ▼
                  ┌─────────┐ ┌────────┐ ┌──────────┐
                  │Classify │ │Enrich  │ │Resolve   │
                  │subagent │ │subagent│ │subagent  │
                  │         │ │        │ │(write)   │
                  └─────────┘ └────────┘ └──────────┘
                       │           │          │
                       ▼           ▼          ▼
                  search_kb  lookup_user  resolve_request
                  classify   read_ticket  update_ticket
                  (2 tools)  (2 tools)    escalate_to_human
                                          (3 tools)
```

### Specialists

| Subagent | Job | Tools (SDK MCP) | Reads | Writes |
|---|---|---|---|---|
| **Classifier** | Map request → one category from the closed set, with confidence. | `search_kb`, `classify_request` | KB, request | — |
| **Enricher** | Resolve the user, the ticket history, frozen/VIP flags. | `lookup_user`, `read_ticket_history` | users.json, tickets log | — |
| **Resolver** | Execute the resolution OR route to a queue OR escalate. | `resolve_request`, `update_ticket`, `escalate_to_human` | — | tickets log, queues |

Each specialist has 2–3 tools. We deliberately do **not** consolidate. The coordinator never calls these tools directly: it always goes through a subagent.

### Context passing

`Agent` (Task) subagents do **not** inherit the coordinator's context. Each dispatch builds an explicit prompt:

- Classifier prompt: full request body, category list with definitions, two few-shot examples (one boundary, one negative), output schema.
- Enricher prompt: only the user identifier and ticket id from classification — not the full request body. We don't want a frozen-account check influenced by the ticket's wording.
- Resolver prompt: classification, enrichment summary, the chosen action (resolve / route / escalate), and the structured payload. Does not see the original raw request body to reduce prompt-injection surface on the write step.

This is the most consequential design choice in this ADR: **the write-capable subagent never sees attacker-controlled prose**. It sees a structured plan from the coordinator.

### The agent loop and `stop_reason`

The coordinator runs a single SDK `query()` call per request with `permissionMode: "default"`. The loop iterates until:

- `stop_reason: "end_turn"` with a structured result that **passes** the validator → success. Log and finalize.
- `stop_reason: "end_turn"` with a result that **fails** the validator → retry (up to N=3) with the validator error fed back as the next user message.
- `stop_reason: "tool_use"` for a tool that triggers the `PreToolUse` hook's hard-deny pattern → the hook returns a deny payload; the coordinator sees the structured error and routes to escalation. Never retries the blocked action.
- `subtype: "error_max_turns"` → escalate as `unknown`. Logged with the partial transcript.
- `subtype: "error_during_execution"` → fail closed: escalate.

Validation-retry: the structured output must match the Zod schema in `src/schemas/decision.ts`. On failure, the specific Zod error is fed back verbatim. We log retry count and error type per request.

### Permissions and the brake

- `canUseTool` callback on the coordinator handles the human-in-the-loop escalation surface. The escalation rules in the Mandate (category × confidence × impact) are evaluated here.
- A `PreToolUse` hook runs before every write tool (`resolve_request`, `update_ticket`). It is **deterministic**: pattern match against frozen accounts, known-bad routes (e.g. routing to CEO), and PII patterns. The hook is the hard stop; the escalation rules are the slow stop. ADR 0002 (planned) will own the prompt vs. hook taxonomy.
- Permission mode `dontAsk` is **not** used. We want explicit `canUseTool` decisions logged.

### Why not one agent

We considered one agent with all 7 tools and a long prompt. Rejected because:

- Tool-selection accuracy drops past ~5 tools.
- The write tool would see the raw request body, expanding the prompt-injection surface.
- We could not evaluate "did the classifier work" separately from "did the resolver work."

We considered fork_session for parallel classification + enrichment. Deferred — the latency win is small at our volume and the cost of two transcripts to merge is real. Revisit if p95 latency becomes a problem.

## Consequences

**Positive**

- Each specialist's tool count stays well under the reliability cliff.
- The eval harness can score classification accuracy and routing accuracy independently.
- The write surface is small and reachable only via the structured Resolver path.

**Negative**

- Three subagent dispatches per request → higher token cost than a single-agent design. Acceptable: the savings on misroute remediation dominate.
- Context-passing discipline is now a code-review item. Adding a field to a subagent prompt is no longer a casual change.
- Debugging a failed request now means reading a coordinator log + up to three subagent transcripts.

## Open questions

- Do we want a session-management policy for related tickets from the same user within a short window? Currently each request is independent. Postponed.
- The Loop (challenge 8) feeds human overrides back into eval set / few-shot. Deferred to a follow-up ADR if pursued.
