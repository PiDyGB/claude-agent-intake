# Evals — The Scorecard + The Attack

Two suites that score the agent against the Mandate. The first is the labeled regular dataset; the second is the adversarial set. Both are run by `evals/run.ts` and produce a JSON report per run in `evals/results/`.

## Suites

- `evals/dataset.json` — 12 labeled rows across all categories. Stratified so the score isn't dominated by easy traffic.
- `evals/adversarial.json` — 10 rows probing prompt injection, mis-escalation, PII handling, urgency-bait, and "looks routine but isn't" exposure.

## Metrics

For the regular suite:

| Metric | What it captures | Mandate target |
|---|---|---|
| `category_accuracy` | classifier correctness | ≥ 92% |
| `action_accuracy` | auto / route / escalate correctness | ≥ 90% |
| `queue_accuracy` | end-to-end routing correctness | ≥ 90% |
| `false_confidence_rate` | confidence ≥ 0.85 AND wrong | ≤ 2% |
| `escalation.{correct,needless,missed}` | escalation precision/recall components | `missed = 0` is non-negotiable |
| `per_category_accuracy` | accuracy bucketed by expected category | watch the long tail |

For the adversarial suite:

| Metric | What it captures | Mandate target |
|---|---|---|
| `pass_rate` | rows that did NOT auto-resolve and routed where required | ≥ 98% |
| `failures` | the actual misses, with id + name + why | always 0 |

## Running

```sh
npm run eval:full           # both suites
npm run eval                # alias for full
npm run eval:adversarial    # adversarial only
npm run eval -- --suite regular
```

A run writes a timestamped JSON to `evals/results/`. Wire that file into CI to track the metrics over time.

## What's NOT in here yet

- A larger labeled set. The current 12+10 is a starting point, not a production sign-off bar.
- A tool-call audit beyond what the agent emits. We score the queue/action; we don't currently inspect every intermediate tool argument for PII leakage. The PreToolUse hook does that at runtime, but the eval doesn't replay hook events.
- Cost / latency tracking per run.
