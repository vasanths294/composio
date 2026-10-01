import { execSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

const LOG_FILE = "run_log.md";

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "no-commit";
  }
})();

export async function log(stage: string, lines: string[]): Promise<void> {
  const time = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = `\n## ${time} · ${commit} · ${stage}\n${lines.join("\n")}\n`;
  console.log(entry);
  await appendFile(LOG_FILE, entry);
}

export function tally<T>(items: T[], key: (item: T) => string, limit = 20): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${k}:${n}`)
    .join("  ");
}
