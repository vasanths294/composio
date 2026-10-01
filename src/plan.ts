import { dataPath, readJson } from "./lib/io";
import type { Graph, GraphNode } from "./lib/types";

const MAX_DEPTH = 4;
const ASK: Record<string, string> = {
  user: "ask the user",
  unresolved: "ask the user (no tool in the catalog returns it)",
};

/** Steps before calling `slug`: ask the user, or call the best producer first (recursively). Context params are collected, not repeated. */
function steps(
  slug: string,
  nodes: Map<string, GraphNode>,
  context: Set<string>,
  depth: number,
  seen: Set<string>,
): string[] {
  const node = nodes.get(slug);
  if (!node) return [`unknown tool: ${slug}`];
  const pad = "  ".repeat(depth + 1);
  const lines: string[] = [];

  for (const need of node.needs) {
    if (need.kind === "context") {
      context.add(need.param);
      continue;
    }
    const [best, ...alternatives] = need.producers;
    if (!best) {
      lines.push(`${pad}- ${need.param}: ${ASK[need.kind] ?? "ask the user"}`);
      continue;
    }
    const how = need.kind === "either" ? "ask the user, or call" : "call";
    const alts = alternatives.length ? ` (or ${alternatives.join(", ")})` : "";
    lines.push(`${pad}- ${need.param}: ${how} ${best}${alts}`);
    if (depth + 1 < MAX_DEPTH && !seen.has(best))
      lines.push(...steps(best, nodes, context, depth + 1, new Set([...seen, slug])));
  }
  return lines;
}

export function formatPlan(slug: string, nodes: Map<string, GraphNode>): string {
  const context = new Set<string>();
  const lines = steps(slug, nodes, context, 0, new Set());
  const header = context.size ? [`  context (ask once): ${[...context].join(", ")}`] : [];
  return [slug, ...header, ...lines].join("\n");
}

if (import.meta.main) {
  const slug = process.argv[2]?.toUpperCase();
  if (!slug) {
    console.error("usage: bun run src/plan.ts <TOOL_SLUG>");
    process.exit(1);
  }
  const graph = await readJson<Graph>(dataPath("graph.json"));
  console.log(formatPlan(slug, new Map(graph.nodes.map((n) => [n.slug, n]))));
}
