import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "..", "..", "logs");

mkdirSync(logDir, { recursive: true });

function logFile(name: string): string {
  return join(logDir, `${name}.jsonl`);
}

export function logEvent(stream: string, payload: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), ...payload };
  appendFileSync(logFile(stream), JSON.stringify(entry) + "\n");
}
