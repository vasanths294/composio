import { createHash } from "node:crypto";
import { z } from "zod";
import { dataPath, exists, readJson, writeJson } from "./lib/io";
import { log, tally } from "./lib/log";
import type { Edge, Graph, GraphNode, Requirement, Tool } from "./lib/types";
import { singular } from "./normalize";

const MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const CACHE_FILE = dataPath("llm_cache.json");
const SHORTLIST_SIZE = 12;
const MIN_CONFIDENCE = 0.7;
const MAX_PRODUCERS = 3;
const CONCURRENCY = 5;

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "list", "get", "returns", "data", "api", "use", "all", "are", "specified", "given"]);

const SYSTEM = `You map tool parameters to the tools that can supply their values.
A candidate qualifies only if its output directly contains a value usable as the parameter (e.g. an id, number, name or email of the right entity).
When a candidate's output is untyped, judge it by its description (a contact search that matches names returns their emails).
Never pick a tool that itself requires the same value. Prefer list/search tools. Return an empty producers list when no candidate fits.
Reply with JSON only: {"params":[{"param":"<name>","producers":[{"tool":"<SLUG>","confidence":<0..1>,"reason":"<short>"}]}]}`;

const Reply = z.object({
  params: z.array(
    z.object({
      param: z.string(),
      producers: z.array(z.object({ tool: z.string(), confidence: z.number().min(0).max(1), reason: z.string() })),
    }),
  ),
});
type Reply = z.infer<typeof Reply>;

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(singular);

const needsLLM = (r: Requirement): boolean => r.kind === "unresolved" || (r.kind === "user" && r.param.endsWith("email"));

function shortlist(consumer: Tool, params: string[], tools: Tool[]): Tool[] {
  const target = new Set([...params.flatMap(words), ...words(consumer.resource)]);
  return tools
    .filter((t) => t.toolkit === consumer.toolkit && t !== consumer && (t.readOnly || ["LIST", "GET", "SEARCH"].includes(t.verb)))
    .filter((t) => !t.required.some((r) => params.includes(r.name)))
    .map((t) => {
      const name = words(t.slug).filter((w) => target.has(w)).length;
      const desc = new Set(words(t.description).filter((w) => target.has(w))).size;
      const discovers = ["LIST", "SEARCH"].includes(t.verb) && desc > 0 ? 2 : 0; // name → contact search → email
      return { t, score: 2 * name + desc + discovers + (t.app === consumer.app ? 1 : 0) };
    })
    .filter((c) => c.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_SIZE)
    .map((c) => c.t);
}

function buildPrompt(consumer: Tool, params: string[], candidates: Tool[]): string {
  const paramLines = consumer.required
    .filter((p) => params.includes(p.name))
    .map((p) => `- ${p.name} (${p.type}): ${p.description.slice(0, 300)}`);
  const candidateLines = candidates.map((t) => {
    const fields = t.outputs.filter((f) => f.depth <= 1).map((f) => f.path).slice(0, 8);
    return `- ${t.slug}: ${t.description.slice(0, 200)} | returns: ${fields.join(", ") || "untyped results"}`;
  });
  return [
    `Tool: ${consumer.slug}`,
    `Description: ${consumer.description.slice(0, 300)}`,
    "Parameters to resolve:",
    ...paramLines,
    "Candidate tools:",
    ...candidateLines,
  ].join("\n");
}

async function askLLM(prompt: string): Promise<Reply> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  return Reply.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
}

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await task(item);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

export async function refineWithLLM(graph: Graph, tools: Tool[]): Promise<Graph> {
  if (!process.env.OPENROUTER_API_KEY) {
    await log("refine", ["skipped: OPENROUTER_API_KEY not set"]);
    return graph;
  }

  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const cache: Record<string, Reply> = (await exists(CACHE_FILE)) ? await readJson(CACHE_FILE) : {};
  const jobs = graph.nodes.filter((n) => n.needs.some(needsLLM));
  const added: Edge[] = [];
  const errors: string[] = [];
  let cached = 0;
  let resolved = 0;

  await runPool(jobs, CONCURRENCY, async (node: GraphNode) => {
    const consumer = bySlug.get(node.slug);
    if (!consumer) return;
    const params = node.needs.filter(needsLLM).map((r) => r.param);
    const candidates = shortlist(consumer, params, tools);
    if (candidates.length === 0) return;

    const prompt = buildPrompt(consumer, params, candidates);
    const key = createHash("sha256").update(`${MODEL}\n${SYSTEM}\n${prompt}`).digest("hex").slice(0, 16);
    let reply = cache[key];
    if (reply) cached++;
    else {
      try {
        reply = await askLLM(prompt).catch(() => askLLM(prompt)); // one retry for malformed JSON
        cache[key] = reply;
      } catch (err) {
        errors.push(`${node.slug}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const allowed = new Set(candidates.map((t) => t.slug));
    for (const answer of reply.params) {
      const need = node.needs.find((r) => r.param === answer.param && needsLLM(r));
      if (!need) continue;
      const edges = answer.producers
        .filter((p) => allowed.has(p.tool) && p.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_PRODUCERS)
        .map((p) => ({ from: p.tool, to: node.slug, param: need.param, score: Math.round(p.confidence * 90) / 100, reason: `llm: ${p.reason}` }));
      if (edges.length === 0) continue;
      need.kind = need.kind === "user" ? "either" : "tool";
      need.producers = edges.map((e) => e.from);
      added.push(...edges);
      resolved++;
    }
  });

  await writeJson(CACHE_FILE, cache);
  const refined = { nodes: graph.nodes, edges: [...graph.edges, ...added] };
  await writeJson(dataPath("graph.json"), refined);

  await log("refine", [
    `model: ${MODEL}  tools sent: ${jobs.length}  cached: ${cached}  errors: ${errors.length}`,
    `params resolved: ${resolved}  edges added: ${added.length}`,
    `still unresolved: ${tally(graph.nodes.flatMap((n) => n.needs).filter((r) => r.kind === "unresolved"), (r) => r.param, 15)}`,
    ...added.slice(0, 8).map((e) => `  + ${e.from} > ${e.to} [${e.param}] ${e.score}`),
    ...errors.slice(0, 3).map((e) => `  ! ${e}`),
  ]);
  return refined;
}
