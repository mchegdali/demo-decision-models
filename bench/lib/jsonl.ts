import { readFileSync } from "node:fs";

/** Reads a JSON-lines file relative to the bench/ directory. */
export function readJsonl<T>(relativePath: string): T[] {
  const url = new URL(`../${relativePath}`, import.meta.url);
  return readFileSync(url, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}
