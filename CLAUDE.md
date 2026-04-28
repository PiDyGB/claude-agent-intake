# CLAUDE.md — Conventions for the Intake Agent project

This file teaches Claude Code how we work in this repo. Read it first.

## What this repo is

A Scenario 5 hackathon submission. The product is an IT Helpdesk triage agent built on the **Claude Agent SDK** (TypeScript). It classifies, enriches, and routes inbound requests; it auto-resolves only two narrow categories. Everything else is escalated to humans. See `docs/mandate.md` for the operating contract.

## Layout

```
src/
  schemas/decision.ts    Zod schemas — single source of truth for shapes
  lib/store.ts           in-memory KB + users + ticket history readers
  lib/log.ts             append-only JSONL logger
  tools/index.ts         6 SDK custom tools, packaged in one MCP server
  agents/
    classifier.ts        specialist subagent — category + confidence
    enricher.ts          specialist subagent — user lookup, never sees body
    resolver.ts          specialist subagent — only one that can WRITE
  brake.ts               PreToolUse hook + canUseTool callback
  coordinator.ts         deterministic orchestration (no LLM)
  cli.ts                 single-ticket CLI entry point
docs/
  mandate.md             challenge 1
  adr/0001-architecture.md  challenge 2
evals/
  dataset.json           regular labeled set (12 rows, stratified)
  adversarial.json       adversarial set (10 rows)
  run.ts                 eval harness producing JSON reports
  unit-brake.ts          deterministic checks for the brake (no LLM)
data/
  knowledge_base.json    synthetic KB
  users.json             synthetic directory + queue list
logs/                    JSONL logs (gitignored)
```

## Conventions

### Tools

- One MCP server (`intake`) holds all 6 tools. Per-specialist allowlists in `src/tools/index.ts:TOOLS` narrow the surface for each subagent.
- Tool descriptions teach the agent **what the tool does NOT do**, input formats, and example queries. When you add a tool, follow the same shape.
- Errors are returned as `{ isError: true, content: [{ type: "text", text: JSON.stringify({ reason_code, guidance, ... }) }] }`. Never throw. Throwing kills the agent loop.
- Reason codes are short snake_case strings the agent can branch on: `not_found`, `ambiguous_identity`, `user_not_found`, `no_match`.

### Schemas

- Every cross-boundary shape (between coordinator ↔ specialists, and at write tools) has a Zod schema in `src/schemas/decision.ts`.
- The classifier and enricher use a validation-retry loop: if the model's text output fails `Schema.safeParse`, the specific Zod error is fed back as the next prompt. Up to N retries (3 for classifier, 2 for enricher), then a safe fallback.
- Categories and queues are closed enums. Adding one requires updating the Mandate, the schema, and the eval set together.

### Subagent context discipline

This is the single most important convention.

**Subagents do not see whatever is convenient. They see exactly what the coordinator hands them.**

- Classifier sees the request body. Necessary — that's the input it classifies.
- Enricher sees the user identifier and the classification. **Not the body.** It must not be influenced by attacker prose.
- Resolver sees the classification, the enrichment, and the structured action plan. **Not the body.** Write tools never receive raw user prose.

Adding a field to a subagent's prompt is a code-review item. Justify it.

### The brake

- `src/brake.ts:writeToolHook` is the **hard stop**. It is a deterministic `PreToolUse` hook on `^mcp__intake__` that denies on: frozen accounts, PII patterns, exec-mention auto-resolves, prompt-injection patterns in tool inputs, bad-route patterns (phishing/P1 to wrong queue), KB-not-in-whitelist auto-resolves.
- `src/brake.ts:buildCanUseTool` is the **slow stop**. It applies the explicit escalation rules from the Mandate (category × confidence × impact × vip). Triggers a deny → forces the resolver to fall back to `route_ticket` with `Q-ESCALATION`.
- Hook runs before `canUseTool`. Order matters; respect it.

### Logging

- Every decision and every hook event is logged as JSONL in `logs/`. Streams: `decisions`, `classifier`, `enricher`, `resolver`, `actions`, `hook_deny`, `escalation_block`, `injection_signal`.
- Logs are append-only and rebuildable. A request should be replayable from log alone.

### Tests / evals

- `npm run eval:brake` — pure deterministic unit checks for `src/brake.ts`. Fast. Run before pushing.
- `npm run eval:adversarial` — runs the agent against `evals/adversarial.json`. Costs API calls.
- `npm run eval:full` — both suites. Run before claiming any metric.
- Eval reports land in `evals/results/<timestamp>.json`. Read the failures section first.

### Style

- TypeScript strict mode + `noUncheckedIndexedAccess`. Don't fight the type system.
- No comments for what the code does. Comments only for **why** when it's non-obvious (constraints, invariants, hidden dependencies).
- Don't add error handling for cases that can't happen. Trust the schema validation at boundaries.
- Don't introduce new abstractions for one caller. Three repeated lines beats a premature helper.

## Don'ts

- Don't add a 7th tool to the same specialist. Tool-selection reliability drops past ~5.
- Don't pass the request body to the resolver. The whole point of the architecture is that it never sees attacker prose.
- Don't widen the auto-resolve KB whitelist (`KB-001`, `KB-005`) without updating the Mandate, the eval set, and getting accuracy ≥ 95% on the relevant rows.
- Don't replace the `PreToolUse` hook with an LLM check. Hooks are deterministic by design.
- Don't merge a change that breaks `npm run typecheck` or `npm run eval:brake`. Both must pass on every commit.

## Running locally

```sh
export ANTHROPIC_API_KEY=sk-...
npm install
npm run typecheck
npm run eval:brake                          # 16 deterministic checks, no API
npm run triage -- evals/sample-ticket.json  # one ticket end-to-end
npm run eval:full                           # full eval suite (uses API)
```
