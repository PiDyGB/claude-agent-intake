# The Mandate — IT Helpdesk Triage Agent

> Challenge 1 deliverable. The agent's job, on one page. Audience: Legal, Security, IT Operations.

## Domain

IT Helpdesk intake. Inbound channels: email, web form, internal chat. Volume: ~200 requests/day. Today: hand-triaged by an L1 rotation. Average time-to-first-response: ~3h. Goal: cut the median to under 5 minutes for routine work, while never being wrong on the cases that matter.

## What the agent decides — alone

The agent has authority to act on its own when **all** of the following hold:

1. The request matches one of the **auto-resolvable categories** in the knowledge base (`auto_resolvable: true`):
   - Password reset for AD-joined accounts (KB-001) — only when MFA is enrolled and the account is not frozen.
   - Software license request from the standard catalog (KB-005) — only when employee status is `active` and the catalog item is in the pre-approved list.
2. **Confidence** in the classification is `>= 0.85`.
3. **Dollar impact** of the action is in the `low` bucket (`<= $50` or no financial impact).
4. The user is not flagged `vip: true` and the account is not flagged `frozen: true`.

When all four hold, the agent performs the resolution action via the `resolve_request` tool and closes the ticket with a logged reasoning chain.

## What the agent decides — then escalates

The agent **must always classify, enrich, and route**, but escalation to a human is required when any of the following hold:

| Trigger | Reason |
|---|---|
| Confidence `< 0.85` on classification | Probabilistic uncertainty — humans handle the long tail. |
| Confidence `< 0.7` on routing | Better to ask than misroute. |
| Dollar impact `medium` or `high` (`> $50`) | Spend control. |
| Category in `{security, p1_incident, frozen_account, vip_request}` | Policy — humans always touch these. |
| Knowledge base says `auto_resolvable: false` | Explicit author intent. |
| User flagged `vip: true` | Reputational risk. |
| The request mentions an executive by name (CEO, CFO, CTO, board) | Likely social engineering or VIP — both warrant a human. |

Escalations write to the `Q-ESCALATION` queue with the agent's draft classification, suggested route, and reasoning chain. A human approves or overrides. Approval is one click.

## What the agent must never touch

These are **hard stops**, enforced both at the prompt level and by a deterministic `PreToolUse` hook in the SDK:

1. **Frozen accounts.** No write action of any kind. Read-only enrichment is allowed; the agent can still classify and route. Enforced by hook on `resolve_request` and `update_ticket` against `users.json:frozen=true`.
2. **MFA reset / device replacement** (KB-007). Identity verification through a secondary channel is not something the agent can perform. Always escalate.
3. **Production P1** (database lag, outage signals, paging keywords like `prod down`, `replica lag`, `outage`, `5xx`, `incident`). Page on-call, do not auto-close.
4. **Phishing reports / suspected compromise** (KB-006). Always Security ops. The agent does not click links, does not "preview" attachments, does not summarize content from suspect URLs.
5. **Any request containing instructions targeted at the agent itself.** Prompt-injection attempts ("ignore prior instructions", "reset all passwords", "route to the CEO regardless of content") are detected by the hook and either rewritten as inert text in context or, if the injection is unambiguous, hard-rejected with a Security routing.
6. **PII exfiltration patterns.** Tool calls that would emit PII (full SSN, full credit card, government ID) outside the system of record are blocked. The hook redacts known patterns before they reach a write tool.
7. **Anything not in the catalog of categories below.** "I don't know" routes to `Q-ESCALATION`. The agent does not invent categories.

## Categories (closed set)

The classifier emits exactly one of:

`password_reset`, `mfa_issue`, `vpn_issue`, `outlook_issue`, `software_license`, `hardware_request`, `phishing_report`, `p1_incident`, `frozen_account_request`, `vip_request`, `unknown`.

`unknown` is a valid output. It always escalates.

## What we are deliberately NOT automating (yet)

- **Hardware procurement.** Even within budget; supply chain implications.
- **Termination / access revocation.** HR-driven, never agent-initiated.
- **Cross-tenant changes** (mergers, acquisitions, contractor onboarding). Compliance review required.
- **Anything affecting a production system** beyond paging the right team.
- **Refunds, comp credits, billing adjustments.** Finance owns this.
- **Direct user communication** beyond a templated acknowledgment. The agent does not write free-form replies to users.

This list is the **default deny**. Adding anything to the auto-resolution set requires (a) a labeled eval set ≥ 50 examples, (b) sign-off from the category owner, and (c) ≥ 95% accuracy on the eval suite. See [the Scorecard](../evals/README.md).

## SLOs and reporting

- **Classification accuracy:** ≥ 92% on the labeled eval set.
- **Mis-escalation rate:** ≤ 5% (auto-resolved when it should have escalated). This is the metric that matters most — false negatives on escalation are how we get hurt.
- **Adversarial pass rate:** ≥ 98% on the prompt-injection suite.
- **False-confidence rate:** ≤ 2% (confidence ≥ 0.85 but answer wrong).
- **Median time-to-first-response:** target ≤ 5 min on auto-resolvable categories, ≤ 15 min on escalations.

Every decision is logged with: input, classification, confidence, route, reasoning chain, retry count, hook events. Logs are append-only JSONL in `logs/`. Replayable from log alone.

## Out-of-scope for this build

- Multi-turn dialogue with end users. The agent processes one request, makes one decision, hands off.
- Auto-resolution outside the two categories above. Adding more is a separate decision with its own eval bar.
- Any external API beyond the in-process tools. We deliberately do not call out to live systems in this hackathon build — every action is logged to a local JSONL and the "queue" is a folder.
