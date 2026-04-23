# Scenario 4. Data & Analytics

## "40 Dashboards, One Metric, Four Answers"

Somewhere in the business there are 40 dashboards across three BI tools. Executives make decisions by gut because the numbers never match. One metric, the one everyone says is *the* metric, is calculated four different ways depending on who you ask. A new VP wants one number, one definition, defended in a room full of people who each think their version is right, plus the ability to ask questions in plain English without waiting a week for analytics.

You pick the domain, the metric, and how deep into data science you go. The only rule: the disagreement has to be *plausible*. Pick a metric where reasonable people could genuinely calculate it differently.

---

## Pick Your Domain (or invent your own)

| Domain | The contested metric | Why nobody agrees |
|---|---|---|
| **Manufacturing** | OEE (Overall Equipment Effectiveness) | Does planned maintenance count as downtime? Startup scrap? |
| **SaaS / subscription** | Churn | Logo versus revenue churn. Does a downgrade count? When does the clock start? |
| **E-commerce / retail** | Customer Lifetime Value | Which margin? Which discount rate? Cohort versus predictive? |
| **Logistics / delivery** | On-Time Delivery | Promised date versus revised date. Partial shipments. Whose clock? |
| **Fintech / lending** | Default rate | 30/60/90 days past due? Principal only? After recoveries? |
| **Healthcare ops** | Bed utilization | Midnight census versus hourly. Does observation count? |
| **Ad tech / media** | Attribution | Last-touch versus multi-touch. Which lookback window? |

---

## Challenges

Waypoints, not a checklist. Pick the ones you want to pursue.

1. **The Room.** *(PM/BA)* Requirements from four stakeholders who each think they're right: the VP, the analyst who built the old dashboards, the ops manager who'll be measured on this, and the finance director whose forecast depends on it. Role-play the interviews with Claude. Capture the disagreements explicitly rather than smoothing them over; they will shape the metric definition.

2. **The Mess.** *(Dev)* Plausible raw data for your domain. Realistic noise: gaps, mislabeled categories, a source in the wrong timezone, duplicates after a retry storm. The ugliness is the point.

3. **The Definition.** *(Architect)* Define the metric once. Every assumption, every edge case, every "what counts," with boundary examples. Replace vague modifiers with concrete thresholds: "recent" should become "within the last 14 calendar days," "significant" should be a numeric cut. Explicit criteria with boundary examples outperform vague instructions. The definition is the first-class citizen of your semantic layer, and every downstream result should carry the definition version that produced it.

4. **The Engine.** *(Dev)* Build the calculation as code with an API, not a SQL view buried in a BI tool. Testable, versioned, explainable. Each result is tagged with the definition version.

5. **The One.** *(Dev/PM)* One dashboard that replaces the 40. Wireframe first, working prototype second. Drill-down from the top-level number to the row an operator actually fixes.

6. **The Reconciliation.** *(Quality)* Your number versus the four existing calculations. A table where rows are edge cases, columns are the five definitions, and cells are what each returns. This is the artifact that wins the room, so prioritize it over dashboard polish.

7. **The Scorecard.** *(Quality)* An eval harness for the NL query system and the metric engine together. A golden set of questions with expected answers, including several that should refuse because the data honestly can't answer them. Metrics: accuracy, refusal accuracy (did it refuse the right ones), and false-confidence rate (confident-and-wrong is the one that gets people fired). Stratified sampling across question types. Runs in CI so the quality numbers move with every semantic-layer change, and the VP has a number to defend when she stops trusting dashboards.

8. **The Question.** *(Stretch)* Natural-language query over your semantic layer. "Why was Tuesday worse than Monday?" should get a real answer, not a chart dump. Teach it with a handful of few-shot examples, including at least one question it should refuse because the data honestly can't answer it. An MCP server over the semantic layer (`get_metric`, `list_definitions`, `explain_calculation`, `compare_periods`) keeps the NL layer thin. If you surface row-level drill-downs, a `PostToolUse` hook that redacts PII deterministically beats trusting the prompt to do it.

9. **The Panel.** *(Stretch, agentic)* "Explain the variance" with Task subagents. When the metric moves unexpectedly, spin up a panel of parallel subagents: one segments by geography, one by product, one by time. Each returns a structured finding with its evidence. A coordinator picks the best explanation and shows the losing theories rather than hiding them. Context passed explicitly in each Task prompt, since subagents don't inherit coordinator context. This hooks into The Question: an anomaly can pre-populate an NL query with "what changed, and why do we think so."

---

## Optional: Start From Data, Not From Zero

- **AdventureWorks for Postgres** ([github.com/lorint/AdventureWorks-for-Postgres](https://github.com/lorint/AdventureWorks-for-Postgres)). Good fit for revenue, on-time, or CLV metrics.
- **Sentinel KYC** ([github.com/beck-source/sentinel-kyc](https://github.com/beck-source/sentinel-kyc)). Fintech and compliance angle. Requires an API key.

If you use one, skip the generation part of Challenge 2, but not the inspection part. Challenge 3 still needs you to pick a contested metric.

---

**Cert domains this scenario stresses:**

- **Prompt Engineering.** Explicit criteria with boundary examples in the metric definition (no "material" or "significant" without thresholds); few-shot for the NL query including at least one refusal case.
- **Tool Design.** MCP server over the semantic layer so the NL layer stays thin and a fresh Claude session reaches for the right tool first.
- **Context Management.** Context preservation across NL questions; `PostToolUse` redaction of PII in drill-down rows; refusal accuracy, stratified sampling, and false-confidence rate on the NL eval (via The Scorecard).
- **Agentic Architecture.** Task subagents for parallel variance explanation, with explicit context passed in each Task call (optional, via The Panel).
