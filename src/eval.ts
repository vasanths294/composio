import { readJson } from "./lib/io";
import { log } from "./lib/log";
import type { Graph, Tool } from "./lib/types";

interface GroundTruth {
  mustExist: [string, string, string][];
  mustNotExist: [string, string, string][];
  noProducers: [string, string][];
  noIncoming: string[];
}

/** Returns true when every hard check passes. Recall on mustExist is reported, not enforced. */
export async function evaluate(graph: Graph, tools: Tool[]): Promise<boolean> {
  const truth = await readJson<GroundTruth>("eval/ground_truth.json");
  const slugs = new Set(tools.map((t) => t.slug));
  const destructive = new Set(tools.filter((t) => t.destructive).map((t) => t.slug));
  const edgeKeys = new Set(graph.edges.map((e) => `${e.from}>${e.to}>${e.param}`));
  const hasEdge = ([from, to, param]: string[]) => edgeKeys.has(`${from}>${to}>${param}`);

  const unknown = [...truth.mustExist, ...truth.mustNotExist]
    .flatMap(([a, b]) => [a, b])
    .concat(truth.noProducers.map(([s]) => s), truth.noIncoming)
    .filter((s): s is string => s !== undefined && !slugs.has(s));

  const missed = truth.mustExist.filter((t) => !hasEdge(t));
  const falsePositives = truth.mustNotExist.filter(hasEdge);
  const wronglyResolved = truth.noProducers.filter(([to, param]) => graph.edges.some((e) => e.to === to && e.param === param));
  const wronglyIncoming = truth.noIncoming.filter((s) => graph.edges.some((e) => e.to === s));
  const invariants = graph.edges.filter((e) => e.from === e.to || destructive.has(e.from));

  const hits = truth.mustExist.length - missed.length;
  const passed = [unknown, falsePositives, wronglyResolved, wronglyIncoming, invariants].every((list) => list.length === 0);
  const fmt = (rows: string[][]) => rows.map((r) => `  - ${r.join(" > ")}`);

  await log("eval", [
    `${passed ? "PASS" : "FAIL"}  recall ${hits}/${truth.mustExist.length} (${Math.round((100 * hits) / truth.mustExist.length)}%)`,
    `false positives: ${falsePositives.length}  wrongly resolved: ${wronglyResolved.length}  wrongly incoming: ${wronglyIncoming.length}  invariant breaks: ${invariants.length}  unknown slugs: ${unknown.length}`,
    ...(missed.length ? ["missed:", ...fmt(missed)] : []),
    ...(falsePositives.length ? ["false positives:", ...fmt(falsePositives)] : []),
    ...(wronglyResolved.length ? ["wrongly resolved:", ...fmt(wronglyResolved)] : []),
    ...(wronglyIncoming.length ? ["wrongly incoming:", ...wronglyIncoming.map((s) => `  - ${s}`)] : []),
    ...(unknown.length ? ["unknown slugs:", ...unknown.map((s) => `  - ${s}`)] : []),
  ]);
  return passed;
}
