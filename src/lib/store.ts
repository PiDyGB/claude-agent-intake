import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "data");

type KBArticle = {
  id: string;
  title: string;
  tags: string[];
  category: string;
  content: string;
  auto_resolvable: boolean;
  auto_resolution_steps?: string[];
};

type User = {
  id: string;
  email: string;
  name: string;
  department: string;
  manager?: string;
  status: "active" | "inactive";
  mfa_enrolled: boolean;
  frozen: boolean;
  frozen_reason?: string;
  vip?: boolean;
  title?: string;
};

let kbCache: KBArticle[] | null = null;
let usersCache: User[] | null = null;

export function getKB(): KBArticle[] {
  if (kbCache) return kbCache;
  const raw = readFileSync(join(dataDir, "knowledge_base.json"), "utf8");
  kbCache = JSON.parse(raw).articles as KBArticle[];
  return kbCache;
}

export function getUsers(): User[] {
  if (usersCache) return usersCache;
  const raw = readFileSync(join(dataDir, "users.json"), "utf8");
  usersCache = JSON.parse(raw).users as User[];
  return usersCache;
}

export function findUser(idOrEmail: string): User | null {
  const needle = idOrEmail.trim().toLowerCase();
  return (
    getUsers().find(
      (u) => u.id.toLowerCase() === needle || u.email.toLowerCase() === needle,
    ) ?? null
  );
}

export function searchKB(queryText: string): KBArticle[] {
  const tokens = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const scored = getKB().map((a) => {
    const hay = (a.title + " " + a.tags.join(" ") + " " + a.content).toLowerCase();
    const score = tokens.reduce((s, t) => (hay.includes(t) ? s + 1 : s), 0);
    return { article: a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.article);
}

export function getKBById(id: string): KBArticle | null {
  return getKB().find((a) => a.id === id) ?? null;
}
