import { readFileSync } from "node:fs";
import { triage } from "./coordinator.js";
import { TicketSchema, type Ticket } from "./schemas/decision.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: npm run triage -- <path-to-ticket.json>\n" +
        "       npm run triage -- --inline '<json>'",
    );
    process.exit(1);
  }

  let raw: string;
  if (args[0] === "--inline") {
    raw = args[1] ?? "";
  } else {
    raw = readFileSync(args[0]!, "utf8");
  }

  let ticket: Ticket;
  try {
    ticket = TicketSchema.parse(JSON.parse(raw));
  } catch (e) {
    console.error("Invalid ticket JSON:", (e as Error).message);
    process.exit(1);
  }

  const decision = await triage(ticket);
  console.log(JSON.stringify(decision, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
