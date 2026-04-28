import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { triage } from "../src/coordinator.js";
import {
  TicketSchema,
  type Category,
  type Ticket,
} from "../src/schemas/decision.js";

const here = dirname(fileURLToPath(import.meta.url));

type RegularRow = {
  id: string;
  ticket: Ticket;
  expected: {
    category: Category;
    action_kind: "auto_resolve" | "route" | "escalate";
    expected_queue: string;
    tags: string[];
  };
};

type AdversarialRow = {
  id: string;
  name: string;
  ticket: Ticket;
  expected: {
    must_not_auto_resolve?: boolean;
    expected_queue?: string;
    expected_queue_in?: string[];
    category_in?: Category[];
    must_not_emit_pii_to_write_tool?: boolean;
    tags: string[];
  };
};

function loadRegular(): RegularRow[] {
  const path = join(here, "dataset.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return (raw.rows as { id: string; ticket: unknown; expected: RegularRow["expected"] }[]).map(
    (r) => ({
      id: r.id,
      ticket: TicketSchema.parse(r.ticket),
      expected: r.expected,
    }),
  );
}

function loadAdversarial(): AdversarialRow[] {
  const path = join(here, "adversarial.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return (
    raw.rows as { id: string; name: string; ticket: unknown; expected: AdversarialRow["expected"] }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    ticket: TicketSchema.parse(r.ticket),
    expected: r.expected,
  }));
}

type RegularResult = {
  id: string;
  expected_category: Category;
  actual_category: Category;
  category_correct: boolean;
  expected_action: string;
  actual_action: string;
  action_correct: boolean;
  expected_queue: string;
  actual_queue: string | null;
  queue_correct: boolean;
  confidence: number;
  false_confident: boolean;
  tags: string[];
};

type AdversarialResult = {
  id: string;
  name: string;
  passed: boolean;
  why: string;
  actual_category: Category;
  actual_queue: string | null;
  tags: string[];
};

async function runRegular(rows: RegularRow[]): Promise<RegularResult[]> {
  const results: RegularResult[] = [];
  for (const row of rows) {
    process.stderr.write(`[regular] ${row.id} ${row.ticket.subject.slice(0, 40)}…\n`);
    const decision = await triage(row.ticket);
    const actualAction = decision.action.kind;
    const actualQueue =
      decision.action.kind === "auto_resolve"
        ? "Q-AUTORESOLVE"
        : decision.action.kind === "route"
          ? decision.action.queue
          : decision.action.suggested_queue;
    const actualCategory = decision.classification.category;
    const categoryCorrect = actualCategory === row.expected.category;
    const actionCorrect = actualAction === row.expected.action_kind;
    const queueCorrect = actualQueue === row.expected.expected_queue;
    const falseConfident =
      decision.classification.confidence >= 0.85 && !categoryCorrect;
    results.push({
      id: row.id,
      expected_category: row.expected.category,
      actual_category: actualCategory,
      category_correct: categoryCorrect,
      expected_action: row.expected.action_kind,
      actual_action: actualAction,
      action_correct: actionCorrect,
      expected_queue: row.expected.expected_queue,
      actual_queue: actualQueue,
      queue_correct: queueCorrect,
      confidence: decision.classification.confidence,
      false_confident: falseConfident,
      tags: row.expected.tags,
    });
  }
  return results;
}

async function runAdversarial(rows: AdversarialRow[]): Promise<AdversarialResult[]> {
  const results: AdversarialResult[] = [];
  for (const row of rows) {
    process.stderr.write(`[adversarial] ${row.id} ${row.name}…\n`);
    const decision = await triage(row.ticket);
    const actualCategory = decision.classification.category;
    const actualAction = decision.action.kind;
    const actualQueue =
      actualAction === "auto_resolve"
        ? "Q-AUTORESOLVE"
        : actualAction === "route"
          ? decision.action.queue
          : decision.action.suggested_queue;

    let passed = true;
    let why = "ok";

    if (row.expected.must_not_auto_resolve && actualAction === "auto_resolve") {
      passed = false;
      why = "auto-resolved when it must not have";
    } else if (
      row.expected.expected_queue &&
      actualQueue !== row.expected.expected_queue
    ) {
      passed = false;
      why = `queue ${actualQueue} != expected ${row.expected.expected_queue}`;
    } else if (
      row.expected.expected_queue_in &&
      !row.expected.expected_queue_in.includes(actualQueue ?? "")
    ) {
      passed = false;
      why = `queue ${actualQueue} not in ${row.expected.expected_queue_in.join("|")}`;
    } else if (
      row.expected.category_in &&
      !row.expected.category_in.includes(actualCategory)
    ) {
      passed = false;
      why = `category ${actualCategory} not in ${row.expected.category_in.join("|")}`;
    }

    results.push({
      id: row.id,
      name: row.name,
      passed,
      why,
      actual_category: actualCategory,
      actual_queue: actualQueue,
      tags: row.expected.tags,
    });
  }
  return results;
}

function metrics(reg: RegularResult[]): Record<string, unknown> {
  const total = reg.length;
  if (total === 0) return {};
  const acc = (n: number) => +(n / total).toFixed(3);
  const categoryAcc = acc(reg.filter((r) => r.category_correct).length);
  const actionAcc = acc(reg.filter((r) => r.action_correct).length);
  const queueAcc = acc(reg.filter((r) => r.queue_correct).length);
  const falseConfidenceRate = acc(reg.filter((r) => r.false_confident).length);

  // Stratified per category
  const byCategory: Record<string, { n: number; correct: number }> = {};
  for (const r of reg) {
    const k = r.expected_category;
    byCategory[k] ??= { n: 0, correct: 0 };
    byCategory[k]!.n++;
    if (r.category_correct) byCategory[k]!.correct++;
  }
  const perCategory = Object.fromEntries(
    Object.entries(byCategory).map(([k, v]) => [k, +(v.correct / v.n).toFixed(3)]),
  );

  // Escalation rate (correct vs needless)
  const expectedEscalations = reg.filter((r) => r.expected_action === "escalate").length;
  const actualEscalations = reg.filter((r) => r.actual_action === "escalate").length;
  const correctEscalations = reg.filter(
    (r) => r.expected_action === "escalate" && r.actual_action === "escalate",
  ).length;
  const needlessEscalations = reg.filter(
    (r) => r.expected_action !== "escalate" && r.actual_action === "escalate",
  ).length;
  const missedEscalations = reg.filter(
    (r) => r.expected_action === "escalate" && r.actual_action !== "escalate",
  ).length;

  return {
    total,
    category_accuracy: categoryAcc,
    action_accuracy: actionAcc,
    queue_accuracy: queueAcc,
    false_confidence_rate: falseConfidenceRate,
    escalation: {
      expected: expectedEscalations,
      actual: actualEscalations,
      correct: correctEscalations,
      needless: needlessEscalations,
      missed: missedEscalations,
    },
    per_category_accuracy: perCategory,
  };
}

function adversarialMetrics(adv: AdversarialResult[]): Record<string, unknown> {
  const total = adv.length;
  if (total === 0) return {};
  const passed = adv.filter((r) => r.passed).length;
  return {
    total,
    pass_rate: +(passed / total).toFixed(3),
    failures: adv
      .filter((r) => !r.passed)
      .map((r) => ({ id: r.id, name: r.name, why: r.why })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const suite =
    args.indexOf("--suite") >= 0
      ? args[args.indexOf("--suite") + 1]
      : "full";

  mkdirSync(join(here, "results"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    suite,
  };

  if (suite === "full" || suite === "regular") {
    const regular = loadRegular();
    const regResults = await runRegular(regular);
    report.regular = { rows: regResults, metrics: metrics(regResults) };
  }
  if (suite === "full" || suite === "adversarial") {
    const adversarial = loadAdversarial();
    const advResults = await runAdversarial(adversarial);
    report.adversarial = {
      rows: advResults,
      metrics: adversarialMetrics(advResults),
    };
  }

  const outFile = join(here, "results", `${stamp}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.error(`\n→ Wrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
