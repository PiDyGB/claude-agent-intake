# Team Intake One — IT Helpdesk Triage Agent

## Participants

- Giuseppe Buzzanca (PM / Architect / Dev / Test — played every role)

## Scenario

**Scenario 5: Agentic Solution — "The Intake"** (Claude Agent SDK).

Picked domain: **IT helpdesk**. Inbound on three channels (email, web form, chat), ~200 requests/day, hand-triaged today by an L1 rotation. The agent classifies, enriches, routes, and (in two narrow cases) auto-resolves. Everything else escalates to humans.

> **Imparare il sistema da zero** — vai su **<https://pidygb.github.io/claude-agent-intake/>** (versione online) oppure apri [docs/index.html](docs/index.html) localmente. È una wiki self-contained (10 tappe + bonus su Zod + bonus su architettura di produzione su AWS + recap) che insegna AI agentica con il Claude Agent SDK partendo dal "cos'è un agent" e camminando attraverso tutto il codice di questo progetto.

## What We Built

An end-to-end triage system on the **Claude Agent SDK** in TypeScript. The repo started empty (just hackathon briefs); it now contains:

- A one-page **Mandate** ([docs/mandate.md](docs/mandate.md)) — what the agent decides alone, what it escalates, what it must never touch, with explicit rules for category × confidence × impact escalation.
- An **architecture ADR** ([docs/adr/0001-architecture.md](docs/adr/0001-architecture.md)) — coordinator + three specialist subagents (Classifier, Enricher, Resolver), with the deliberate choice that the write-capable subagent **never sees the original request body**, only a structured plan from the coordinator. This is the design's most consequential prompt-injection defense.
- A **deterministic coordinator** ([src/coordinator.ts](src/coordinator.ts)) — plain TypeScript, no LLM. It calls the three subagents in sequence and applies the escalation rules in code (auditable, replayable).
- **Six custom tools** ([src/tools/index.ts](src/tools/index.ts)) bundled in one in-process MCP server. Tool descriptions teach what each tool does NOT do; errors return `isError: true` with a `reason_code` so the agent can recover. Per-specialist allowlists keep each agent under the 5-tool reliability cliff.
- **The Brake** ([src/brake.ts](src/brake.ts)) — a `PreToolUse` hook that hard-stops on frozen accounts, PII patterns, exec-mention auto-resolves, prompt-injection patterns in tool inputs, and bad-route patterns; plus a `canUseTool` callback that enforces the explicit escalation rules. Hook = hard stop, callback = slow stop.
- **Validation-retry loops** in the Classifier (N=3) and Enricher (N=2). Zod schemas at every boundary; failed parses are fed back as the next prompt with the specific error.
- **The Scorecard + The Attack** ([evals/](evals/)) — a regular labeled set of 12 stratified rows, an adversarial set of 10 rows (prompt injection, PII, frozen account, exec impersonation, urgency bait, looks-routine-isn't legal exposure), and an eval harness that emits accuracy, escalation precision/recall, false-confidence rate, and adversarial pass rate as a JSON report. Plus 16 deterministic unit checks for the brake that need no API key (`npm run eval:brake`).
- **JSONL logs** of every decision, hook event, and escalation block — replayable from the log alone.

What runs vs. scaffolding vs. faked:

- **Runs end-to-end:** brake unit checks, typecheck, full coordinator pipeline (with `ANTHROPIC_API_KEY`).
- **Synthetic data:** the KB and the user directory are JSON files in `data/`. The "queues" are append-only log streams. No external system is called.
- **Not implemented:** The Loop (challenge 8 — feeding human overrides back into eval data), live channel ingestion, multi-turn user dialogue.

## Challenges Attempted

| # | Challenge | Status | Notes |
|---|---|---|---|
| 1 | The Mandate | **done** | One page, what's deliberately not automated, escalation rules with thresholds. |
| 2 | The Bones | **done** | ADR with diagram, coordinator + 3 specialists, explicit context passing, `stop_reason` handling. |
| 3 | The Tools | **done** | 6 tools, structured errors with reason codes, descriptions teach boundaries, ≤3 per specialist. |
| 4 | The Triage | **done** | Coordinator agent built, validation-retry loops with Zod, per-call retry count logged. |
| 5 | The Brake | **done** | `PreToolUse` hook (hard stop, deterministic) + `canUseTool` (slow stop, escalation rules). |
| 6 | The Attack | **done** | 10-row adversarial set covering injection, PII, frozen, exec, ambiguity. |
| 7 | The Scorecard | **done** | Eval harness with stratified accuracy, escalation precision/recall, false-confidence rate, adversarial pass rate. JSON reports per run. |
| 8 | The Loop | **skipped** | Out of scope for this build. Mentioned as next step in the ADR. |

## Key Decisions

The biggest calls. Full reasoning in [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).

1. **Coordinator + 3 specialists, not one big agent.** Tool-selection reliability drops past ~5 tools. Splitting also lets us evaluate sub-decisions independently.
2. **Resolver never sees the raw request body.** It only sees the structured plan. Attacker-controlled prose cannot reach a write tool. This is the architecture's prompt-injection defense.
3. **Coordinator is plain TypeScript, not an LLM.** The orchestration logic, the action picker, the escalation rule application — all auditable code. Only the three specialist decisions are LLM-driven.
4. **Two layers of brake: hook + canUseTool.** Hook is deterministic (frozen accounts, PII, exec mentions, KB whitelist) and cannot be talked out of. The callback enforces the policy table from the Mandate (category × confidence × impact). Hook = hard stop, callback = slow stop.
5. **Auto-resolve gated by an explicit KB whitelist** (`KB-001`, `KB-005`). Adding a third requires updating the Mandate, the eval set, and clearing 95% accuracy on the relevant rows.
6. **Validation-retry with Zod, not "prompt for JSON".** Schema is the contract. Errors are fed back verbatim. Retry counts are logged.

## How to Run It

Assume Node 20+ and an Anthropic API key.

```sh
git clone <this repo>
cd claude-code-hackathon

export ANTHROPIC_API_KEY=sk-...    # required for any LLM call
npm install

# 1. Static checks (no API)
npm run typecheck                  # strict TS, must pass
npm run eval:brake                 # 16 deterministic brake checks

# 2. End-to-end on one ticket
npm run triage -- evals/sample-ticket.json

# 3. Full eval suite (uses API)
npm run eval:full                  # both regular and adversarial
npm run eval:adversarial           # adversarial only

# Eval reports land in evals/results/<timestamp>.json.
# Decision + hook logs land in logs/*.jsonl.
```

Sample ticket JSON shape — see [src/schemas/decision.ts](src/schemas/decision.ts):

```json
{
  "id": "T-...",
  "channel": "email" | "web_form" | "chat",
  "subject": "...",
  "body": "...",
  "from_email": "user@example.com",
  "from_user_id": "U001",
  "received_at": "ISO 8601 timestamp"
}
```

## If We Had More Time

In priority order, with honesty about what's held together with tape:

1. **The Loop (challenge 8).** When a human overrides the agent in `Q-ESCALATION`, capture the labeled example into `evals/dataset.json` automatically and surface it as a few-shot example for the classifier. Today the override is logged but not fed back.
2. **Larger labeled eval set.** 12+10 rows is a starting point, not a sign-off bar. Target: 50 per category before any expansion of the auto-resolve whitelist.
3. **Replay-based audit of write tool inputs.** The PreToolUse hook catches PII at runtime; the eval doesn't currently replay hook events to score "would this have leaked PII". Add a hook-replay layer to the harness.
4. **Real channel ingestion.** Today input is a JSON file. A webhook for the email channel + an MCP server wrapper (so a fresh Claude Code session picks the right tool first try) would close the gap.
5. **Cost / latency budgets in CI.** The eval harness records nothing about token spend; we should track and gate on it.
6. **A second ADR on prompt vs. hook taxonomy.** Mentioned in ADR 0001 as planned. The cert exam tests this distinction; it deserves its own document.

The taped-together bits: the synthetic ticket history (a hardcoded count), the in-memory "queues" (append-only JSONL files), and the schema for `read_ticket_history` returning a count instead of richer signals. Each is a deliberate hackathon shortcut, not a design.

## How We Used Claude Code

What worked best:

- **Claude reading the SDK docs into the prompt** rather than guessing from training data. The SDK's `tool()` signature changed between docs revisions (no fifth-arg annotations parameter in this version); fetching the actual docs caught it before it broke the build.
- **Skill: `code-review` and explicit subagent dispatch in the architecture.** Building the agent that uses subagents while *being* an agent that uses subagents made the trade-offs concrete in a way reading docs didn't.
- **Schemas as the contract.** Writing the Zod schemas first turned the validation-retry loop into 20 lines of glue rather than a prompt-engineering project.

What surprised:

- The biggest defensive wins were structural (Resolver-sees-no-body) and deterministic (PreToolUse hook + escalation table), not prompt-engineering. The prompts are short. The architecture does the work.
- Adversarial cases that pass the brake's deterministic patterns still need clear escalation rules — patterns alone aren't enough. The "exec mentions" rule on auto-resolve is a good example.

Where it saved the most time: scaffolding (package.json, tsconfig, three subagent files following one template), the eval harness, and the JSON shape of the dataset/adversarial files. Plumbing went from a half-day to under an hour.
