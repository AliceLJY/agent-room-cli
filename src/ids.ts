import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function stableId(input: string, prefix = "p"): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `${prefix}_${digest}`;
}

export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "agent";
}
