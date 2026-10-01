import { EVAL_SETS, evaluate } from "./eval";
import { fetchTools } from "./fetch";
import { buildGraph } from "./graph";
import { inspectTools } from "./inspect";
import { log } from "./lib/log";
import { normalizeTools } from "./normalize";
import { formatPlan } from "./plan";
import { refineWithLLM } from "./refine";
import { renderHtml } from "./viz";

const args = new Set(process.argv.slice(2));
const PLAN_EXAMPLES = [
  "GOOGLESUPER_REPLY_TO_THREAD",
  "GOOGLESUPER_SEND_EMAIL",
  "GITHUB_CREATE_AN_ISSUE_COMMENT",
  "GITHUB_GET_A_REVIEW_FOR_A_PULL_REQUEST",
];

try {
  await fetchTools(args.has("--refresh"));
  if (args.has("--inspect")) await inspectTools();
  const tools = await normalizeTools();
  const base = await buildGraph();
  const graph = args.has("--no-llm") ? base : await refineWithLLM(base, tools);
  await renderHtml(graph);
  const nodes = new Map(graph.nodes.map((n) => [n.slug, n]));
  await log(
    "plan examples",
    PLAN_EXAMPLES.map((slug) => formatPlan(slug, nodes)),
  );
  for (const set of EVAL_SETS) {
    const passed = await evaluate(graph, tools, set);
    if (set.name === "tuning" && !passed) process.exitCode = 1;
  }
} catch (err) {
  await log("error", [err instanceof Error ? (err.stack ?? err.message) : String(err)]);
  process.exit(1);
}
