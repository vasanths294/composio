import { readJson } from "./lib/io";
import { log } from "./lib/log";
import type { Graph, Tool } from "./lib/types";

interface GroundTruth {
  mustExist: [string, string, string][];
  mustNotExist: [string, string, string][];
  noProducers: [string, string][];
  noIncoming: string[];
}

export const EVAL_SETS = [
  { name: "tuning", file: "eval/ground_truth.json" }, // used while developing the rules; enforced
  { name: "held-out", file: "eval/held_out.json" }, // written after tuning, never tuned against; reported
] as const;

/** Returns true when every hard check passes. Recall on mustExist is reported, not enforced. */
export async function evaluate(graph: Graph, tools: Tool[], set: (typeof EVAL_SETS)[number]): Promise<boolean> {
  const truth = await readJson<GroundTruth>(set.file);
  const slugs = new Set(tools.map((t) => t.slug));
  const destructive = new Set(tools.filter((t) => t.destructive).map((t) => t.slug));
  const edgeKeys = new Set(graph.edges.map((e) => `${e.from}>${e.to}>${e.param}`));
  const hasEdge = ([from, to, param]: string[]) => edgeKeys.has(`${from}>${to}>${param}`);
  const got = ([, to, param]: string[]) =>
    graph.edges
      .filter((e) => e.to === to && e.param === param)
      .map((e) => e.from)
      .join(", ") || "nothing";

  const unknown = [...truth.mustExist, ...truth.mustNotExist]
    .flatMap((edge) => edge.slice(0, 2)) // from, to (not the param)
    .concat(
      truth.noProducers.map(([s]) => s),
      truth.noIncoming,
    )
    .filter((s): s is string => s !== undefined && !slugs.has(s));

  const missed = truth.mustExist.filter((t) => !hasEdge(t));
  const falsePositives = truth.mustNotExist.filter(hasEdge);
  const wronglyResolved = truth.noProducers.filter(([to, param]) =>
    graph.edges.some((e) => e.to === to && e.param === param),
  );
  const wronglyIncoming = truth.noIncoming.filter((s) => graph.edges.some((e) => e.to === s));
  const invariants = graph.edges.filter((e) => e.from === e.to || destructive.has(e.from));

  const hits = truth.mustExist.length - missed.length;
  const passed = [unknown, falsePositives, wronglyResolved, wronglyIncoming, invariants].every(
    (list) => list.length === 0,
  );
  const rows = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `  - ${i}`)] : []);

  await log(`eval ${set.name}`, [
    `${passed ? "PASS" : "FAIL"}  recall ${hits}/${truth.mustExist.length} (${Math.round((100 * hits) / truth.mustExist.length)}%)`,
    `false positives: ${falsePositives.length}  wrongly resolved: ${wronglyResolved.length}  wrongly incoming: ${wronglyIncoming.length}  invariant breaks: ${invariants.length}  unknown slugs: ${unknown.length}`,
    ...rows(
      "missed",
      missed.map((m) => `${m.join(" > ")}  (got: ${got(m)})`),
    ),
    ...rows(
      "false positives",
      falsePositives.map((m) => m.join(" > ")),
    ),
    ...rows(
      "wrongly resolved",
      wronglyResolved.map((m) => m.join(" > ")),
    ),
    ...rows("wrongly incoming", wronglyIncoming),
    ...rows("unknown slugs", unknown),
  ]);
  return passed;
}
