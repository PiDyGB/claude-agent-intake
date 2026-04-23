# Scenario 1. Code Modernization

## "The Monolith"

Northwind Logistics runs on something old. It works, mostly, but the people who built it are gone, the docs are a folder of outdated Word files, and the board just approved "modernization" without defining what that means. Prove it can be evolved safely without a big-bang rewrite.

You pick the language, the era, the architecture, the decomposition strategy. The only rule: generate something ugly enough that fixing it is interesting.

---

## Pick Your Legacy (or invent your own)

| Flavor | What Claude generates for you |
|---|---|
| **PHP 5 monolith** | `index.php`, SQL strings concatenated inline, sessions in globals |
| **Enterprise Java 2010** | Spring XML config, `AbstractSingletonProxyFactoryBean`, WAR on WebLogic |
| **Stored-proc architecture** | 40 T-SQL procs that *are* the business logic, app is a thin shell |
| **Early Node callback hell** | Express 3, callbacks 6 deep, logic in Mongoose pre-save hooks |
| **Rails 2 majestic monolith** | Fat models, `lib/` doing unspeakable things, cron plus rake jobs |
| **Classic ASP / VB6** | COM components, ADO recordsets, inline VBScript |
| **SOAP service tangle** | WSDL files, an ESB that's actually just a queue |
| **COBOL plus batch** | Fixed-width files, JCL, nightly batch that can't be interrupted |

**Modernize toward:** Strangler fig, containerize-and-ship, event-driven, API façade, serverless extraction, DB-first split. Your call.

---

## Challenges

Waypoints, not a checklist. Pick the ones you want to pursue.

1. **The Stories.** *(PM)* User stories for the handful of business capabilities that actually matter. Acceptance criteria sharp enough that a tester could execute them. Stakeholders will disagree about priorities; capture those disagreements explicitly rather than smoothing them over. A crisp story set also makes it easier for Claude to scaffold tests from it later.

2. **The Patient.** *(Architect)* Generate the legacy monolith. Shared database, circular dependencies, a god class or two, business logic hiding in a database trigger. Make it realistic, including the parts that make you wince. The ugliness is what makes everything downstream interesting. If you'd rather skip generation, use the BYO option below.

3. **The Map.** *(Architect)* Your decomposition plan as an ADR, not a slide. Name the seams. Rank services by extraction risk rather than size. Include a "what we chose *not* to do" section. A three-level `CLAUDE.md` pays off here: user-level for personal preferences, project-level for codebase conventions, directory-level so the monolith root and the new-service root each get the context that fits them.

4. **The Pin.** *(Tester)* Characterization tests against the monolith before anyone touches it. Not correctness tests, behavior-pinning tests, bugs included. When someone changes behavior unintentionally later, the failure message should tell them precisely what changed.

5. **The Cut.** *(Dev)* Extract your first service with a clean API contract. The monolith still works, the service works, and both are provable from a single test run: the characterization suite plus a new contract test, green on the same commit.

6. **The Fence.** *(Dev/Tester)* Between old and new, an anti-corruption layer. The monolith's data model must not leak into the new service's public shape. A test that fails loudly if a monolith field name ever appears in the new service's API is a good forcing function. If you also want to prevent Claude from writing across the boundary, a `PreToolUse` hook enforces it deterministically; pair it with a prompt in the project `CLAUDE.md` that says "prefer the new service for X," and write a short ADR on why the hard block is a hook and the preference is a prompt.

7. **The Scorecard.** *(Quality)* An eval harness for the LLM-driven refactoring itself, because same prompt plus same module doesn't mean same output. A golden set of known-good extractions (labeled "correct seam" versus "incorrect seam" for modules you generated), plus the characterization suite as a behavior-preservation check. Metrics: does Claude propose the right boundaries, does the characterization suite still pass after Claude's refactor, and how often does it claim high confidence on a wrong answer. Runs in CI so every Claude-proposed change carries a defensible number, and the modernization workflow stops being a vibe.

8. **The Weekend.** *(Stretch)* A cutover runbook ops will actually follow at 3am. Steps, rollback triggers, the decision tree. Rehearse it at least once so it isn't purely theoretical.

9. **The Scouts.** *(Stretch, agentic)* Fan-out analysis with Task subagents. One subagent per candidate seam from The Map, each independently scoring extraction risk (coupling, test coverage, data-model tangle, business criticality) and reporting a structured verdict. A coordinator aggregates into a ranked list. Pass scope explicitly in each Task prompt, since subagents don't inherit the coordinator's context. Compare the agent-generated ranking against the human-written one from The Map and note where they agree, where they differ, and why.

---

## Optional: Bring Your Own Monolith

Don't want to generate the legacy? We've got one.

[https://github.com/rishikeshradhakrishnan/spring-music](https://github.com/rishikeshradhakrishnan/spring-music)

Spring Music is a Spring Boot sample app built for Cloud Foundry. It stores the same domain objects across relational, document, and key-value stores using bean profiles and Spring Cloud Connectors. Fine to skip the generation challenge if you use it.

---

**Cert domains this scenario stresses:**

- **Claude Code Config.** Three-level `CLAUDE.md` across a multi-module legacy; custom commands plus skills for the extraction playbook.
- **Context Management.** Hook plus prompt guidance for the service boundary, with an ADR explaining why each is which; stratified sampling and false-confidence rate on the refactoring eval (via The Scorecard).
- **Agentic Architecture.** Task subagents to score extraction risk in parallel, with explicit context passed in each Task call (optional, via The Scouts).
