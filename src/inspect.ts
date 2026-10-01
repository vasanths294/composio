import { dataPath, readJson } from "./lib/io";
import { log, tally } from "./lib/log";
import { TOOLKITS, type Toolkit } from "./lib/types";
import { isObj } from "./normalize";

const SAMPLES: Record<Toolkit, RegExp[]> = {
  googlesuper: [/REPLY_TO_THREAD$/, /LIST_THREADS$/],
  github: [/CREATE_AN_ISSUE_COMMENT$/, /LIST_REPOSITORY_ISSUES$/],
};
const MAX_SAMPLE_CHARS = 1500;

export async function inspectTools(): Promise<void> {
  const lines: string[] = [];

  for (const toolkit of TOOLKITS) {
    const tools = (await readJson<unknown[]>(dataPath(`${toolkit}_tools.json`))).filter(isObj);
    const slug = (t: Record<string, unknown>) => String(t.slug ?? "");

    lines.push(
      `### ${toolkit}: ${tools.length} tools`,
      `keys: ${tally(tools.flatMap((t) => Object.keys(t)), (k) => k)}`,
      `prefixes: ${tally(tools, (t) => slug(t).split("_")[0] ?? "?")}`,
      `scopes: ${tally(tools.flatMap((t) => (Array.isArray(t.scopes) ? t.scopes.map(String) : [])), (s) => s, 15)}`,
      `tags: ${tally(tools.flatMap((t) => (Array.isArray(t.tags) ? t.tags.map(String) : [])), (s) => s, 15)}`,
    );

    for (const pattern of SAMPLES[toolkit]) {
      const match = tools.find((t) => pattern.test(slug(t)));
      const json = match ? JSON.stringify(match) : "NO MATCH";
      lines.push(`sample ${pattern}: ${json.slice(0, MAX_SAMPLE_CHARS)}${json.length > MAX_SAMPLE_CHARS ? "…" : ""}`);
    }
  }

  await log("inspect", lines);
}
