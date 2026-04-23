# Scenario 3. Data Engineering

## "The Swamp"

Fabrikam Retail has seven source systems: POS, e-commerce, loyalty, CRM, and three more picked up through mergers. None of them agree on what a "customer" is. Same person, four IDs, two spellings. The analytics team gave up and builds everything from CSV exports. The new CDO wants a single source of truth.

You pick the architecture and the stack: lakehouse, warehouse, mesh, your choice.

---

## Challenges

Waypoints, not a checklist. Pick the ones you want to pursue.

1. **The Mess.** *(Dev)* Realistic sample data across a handful of the sources. Different schemas, conflicting keys, encoding problems, a timezone bug, duplicates that aren't obvious. Prompt Claude explicitly to produce the kind of bad data real systems emit, not synthetic-looking noise. A few few-shot examples contrasting "good bad data" with "bad bad data" will teach it the difference. The realism is what makes matching and data quality worth doing later.

2. **The Blueprint.** *(Architect)* Target architecture. Layers, zones, retention, PII rules, who reads what. Commit as an ADR with a "what we deliberately chose not to do" section. A three-level `CLAUDE.md` pays off: repo root for the overall pattern, per-zone for the rules that differ between raw, conformed, and curated (mutation, retention, PII), user-level for personal preferences.

3. **The Intake.** *(Dev)* Ingestion for a few sources with different shapes (batch file, CDC stream, flaky API). All land in the raw layer with lineage metadata. Wrap the parse-and-land step in a validation-retry loop: Claude parses semi-structured input into your schema, a structured validator checks it, on failure the specific error is fed back and Claude retries up to N times. Log retry count and error type per row; those numbers become evidence later.

4. **The Customer.** *(Dev/Architect)* Master the customer entity across sources. Explicit survivorship rules. A golden record with a confidence score. Teach the matcher with a few sharp boundary examples, including at least one negative case ("these two records look alike but are not the same person, and here's why"). Two crisp boundary examples reliably outperform a page of "be conservative."

5. **The Tripwire.** *(Quality)* Data quality checks: schema drift, null explosions, volume anomalies, referential integrity. For each check, decide whether it breaks the pipeline or just alerts, and document the rule. These are deterministic guardrails, so enforce them in code rather than prompts. A `PreToolUse` hook that blocks writes into the curated zone until the schema contract passes is a natural fit.

6. **The Catalog.** *(PM/BA)* Catalog entries for the core entities, written for an analyst rather than an engineer. What is this, where did it come from, can I trust it, what does "customer" mean *here*. Link each entry to its upstream contract so analysts can see what the producer is actually promising.

7. **The Scorecard.** *(Quality)* An eval harness for the entity matcher. A golden dataset of labeled match, non-match, and unclear pairs, including the boundary cases your few-shot prompt is trying to teach. Metrics: precision, recall, and false-confidence rate (how often the matcher says "high confidence" and is wrong). Stratified sampling so the score doesn't get dominated by easy cases. Runs in CI so the CDO has a defensible single number when she asks "how good is this."

8. **The Trace.** *(Stretch)* Lineage end-to-end. Given one bad value in a report, walk it back to the source row programmatically, including any transformations along the way. An MCP server over the data platform (`preview_table`, `trace_lineage`, `find_record`, `get_source_schema`) is a natural fit. Tool descriptions that include input formats, edge cases, and what each tool does *not* do help a fresh Claude session pick the right tool on the first try.

9. **The Swarm.** *(Stretch, agentic)* Parallel profiling with Task subagents. One subagent per source from The Mess, each scoring data quality (completeness, freshness, key coverage, anomaly count, PII surface) and emitting a structured report. A coordinator aggregates into a single "swamp health" dashboard. Context passed explicitly in each Task prompt, since subagents don't inherit coordinator context. Showing exactly what each subagent received in its prompt is part of the artifact; it makes the decomposition legible to a reviewer.

---

## Optional: Start From Data, Not From Zero

- **AdventureWorks for Postgres** ([github.com/lorint/AdventureWorks-for-Postgres](https://github.com/lorint/AdventureWorks-for-Postgres)). Classic retail schema. Good fit for customer-entity work.
- **Sentinel KYC** ([github.com/beck-source/sentinel-kyc](https://github.com/beck-source/sentinel-kyc)). KYC data with a compliance angle. Requires an API key.

If you use one, skip the generation half of Challenge 1 but not the inspection half. Go find the noise that's already in there and document it.

---

**Cert domains this scenario stresses:**

- **Prompt Engineering.** Few-shot boundary examples for entity matching, including at least one negative case; validation-retry loops on ingestion.
- **Tool Design.** MCP server over the data platform with lineage and preview tools; descriptions that help a fresh Claude session pick the right tool on the first try.
- **Context Management.** Field-level confidence on the golden record; hook-enforced curated-zone guardrails paired with prompt-level zone preferences; stratified sampling and false-confidence rate on the matcher eval (via The Scorecard).
- **Agentic Architecture.** Task subagents for parallel source profiling, with explicit context passed in each Task call (optional, via The Swarm).
