# Scenario 2. Cloud Migration

## "The Lift, the Shift, and the 4am Call"

Contoso Financial runs three workloads on-prem: a customer-facing web app, a nightly batch reconciliation job, and a reporting database that five teams query directly. The CFO signed the cloud contract. The CTO wants "cloud-native, not lift-and-shift." Compliance wants residency controls. SRE wants sleep. They are not aligned.

You pick the target cloud and the migration pattern. You won't deploy live. Produce cloud-ready artifacts that run locally with production-equivalent architecture. Docker Compose with services mapped to cloud primitives: MinIO stands in for S3, Postgres for RDS, Redis for ElastiCache. Name things accordingly.

The auditor will read your IaC, the CTO will read your ADRs, and ops will run your runbook at 4am. Design for all three readers.

---

## Challenges

Waypoints, not a checklist. Pick the ones you want to pursue.

1. **The Memo.** *(PM/BA)* The decision memo. Lift-and-shift first then optimize, or refactor on the way in? Pick a side. Make the case. Name the risks you're accepting and who bears them. One page, no hedging. Legal and the CFO are in the audience.

2. **The Discovery.** *(Architect)* Surface the real current state: the three workloads, their configs, and the ugly inter-dependencies nobody documented (a hardcoded IP, a shared filesystem mount, a cron pinging an endpoint to keep a cache warm). Role-play the stakeholder interviews with Claude if it helps draw the details out. Whatever you uncover should visibly shape the architecture choices in the next challenge.

3. **The Options.** *(Architect)* A handful of candidate target architectures on your chosen cloud, scored on cost, risk, speed, and operability, with a recommendation. Reference actual services by name (ECS versus EKS, App Service versus Container Apps, your call). Commit the recommendation as an ADR. A per-workload `CLAUDE.md` starts paying off here: the batch folder and the web-app folder deserve different guidance for Claude when someone edits them.

4. **The Container.** *(Dev)* Containerize the web app. Multi-stage build, non-root user, health check endpoint. Runs locally via `docker compose`. The same image would deploy to your target cloud with a config swap rather than a rebuild.

5. **The Foundation.** *(Platform)* Infrastructure-as-code for the full target architecture. It won't deploy to a live cloud, but it needs to *read right*: idempotent, no hardcoded secrets, a state-file story that isn't "check it in." A `PreToolUse` hook that deterministically blocks any Claude edit writing a plaintext secret into IaC is a cheap, high-value guardrail. Pair it with a prompt in `CLAUDE.md` that says "prefer the secret manager for X" and a short ADR on why the block is a hook and the preference is a prompt.

6. **The Proof.** *(Quality)* A validation suite that defines "migration succeeded": smoke tests, contract tests, data-integrity checks. Runs against the local stand-in now, runs again against the real cloud post-cutover. At least a few assertions should specifically catch the undocumented things from Discovery, so the validation isn't just theatre.

7. **The Scorecard.** *(Quality)* An eval harness for Claude's IaC and migration outputs, because same prompt plus same workload doesn't mean same Terraform. A golden set of known-good IaC snippets, known-bad patterns (over-permissive IAM, hardcoded secrets, missing tags, open security groups), and reference migration plans. Metrics: does Claude's IaC match the golden standard, does it correctly flag the bad patterns, and how often does it confidently propose something the hook would block. Runs in CI so the non-interactive Claude review has a score to defend rather than a vibe.

8. **The Undo.** *(Stretch)* Rollback plan per workload, per cutover stage. Exact sequence, not a diagram. The one nobody wants to write but everyone needs at 4am. Walk through it at least once so it isn't purely theoretical.

9. **The Survey.** *(Stretch, agentic)* Parallel discovery with Task subagents. One subagent per workload (web app, batch job, reporting database), each reading configs, probing dependencies, and emitting a structured current-state report. A coordinator merges them into a single discovery doc. Pass scope explicitly in each Task prompt, since subagents don't inherit coordinator context. The merged output should surface at least one cross-workload coupling a single-pass analysis would miss, and it should visibly sharpen the architecture choices in The Options.

---

**Cert domains this scenario stresses:**

- **Claude Code Config.** Per-workload `CLAUDE.md`; non-interactive Claude in CI for IaC review; Plan Mode for cutover steps.
- **Context Management.** Hook plus prompt guidance for secrets in IaC; escalation rules for the cutover decision; stratified sampling and false-confidence rate on the IaC eval (via The Scorecard).
- **Tool Design.** MCP server over the local cloud stand-in, with tool descriptions that teach the agent what each tool does *not* do.
- **Agentic Architecture.** Task subagents for parallel workload discovery, with explicit context passed in each Task call (optional, via The Survey).
