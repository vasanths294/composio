import { readFile, writeFile } from "node:fs/promises";
import { log } from "./lib/log";
import type { Graph } from "./lib/types";

const TEMPLATE = "src/viz.html";
const OUTPUT = "graph.html";

/** Embeds the graph into a single HTML file that opens directly in a browser. */
export async function renderHtml(graph: Graph): Promise<void> {
  const template = await readFile(TEMPLATE, "utf-8");
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  await writeFile(OUTPUT, template.replace("/*DATA*/null", data));
  await log("viz", [`${OUTPUT}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`]);
}
