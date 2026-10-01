import { dataPath, readJson, writeJson } from "./lib/io";
import { log, tally } from "./lib/log";
import type { Edge, Graph, GraphNode, OutputField, Param, ParamKind, Tool } from "./lib/types";

const CONTEXT_SHARE = 0.2; // required by >=20% of a toolkit's tools → ask the user once, not an edge
const MIN_SCORE = 0.65;
const MAX_PRODUCERS = 3;
const HINT_SCORE = 0.95;

const BARE = new Set(["id", "name", "key", "number", "sha", "slug"]);
const ID_NAME = /(^|_)(id|number|sha|slug|uuid)$/;
const REFERENCE_SUFFIX = new Set(["name", "email", "login", "slug", "key"]); // values a user could also type
const SLUG_REF = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

const compact = (s: string): string => s.replace(/_/g, "");
const singularIds = (name: string): string => name.replace(/(^|_)ids$/, "$1id").replace(/(^|_)numbers$/, "$1number");

const ID_DESC = /\b(ID|IDs|SHA)\b/;
const isIdentifier = (p: Param): boolean =>
  ID_NAME.test(singularIds(p.name)) ||
  ID_DESC.test(p.description) ||
  /\b(identifier|resource name)\b/i.test(p.description);

export interface Key {
  name: string;
  loose: boolean; // allow entity-prefix matching (pull_number ↔ pull_request_number)
}

/** Output field names that would satisfy this parameter. */
function keysFor(p: Param, consumer: Tool): Key[] {
  const base = singularIds(p.name);
  const tokens = base.split("_");
  const identifier = isIdentifier(p);
  const keys: Key[] = [];

  if (BARE.has(base)) {
    if (consumer.verb === "CREATE") return keys; // a new entity's own name/id comes from the user
    keys.push({ name: `${consumer.resource}_${base}`, loose: false });
    keys.push({ name: `${consumer.resource.split("_").at(-1)}_${base}`, loose: false });
  } else if (identifier || REFERENCE_SUFFIX.has(tokens.at(-1) ?? "")) {
    keys.push({ name: base, loose: identifier });
    if (tokens.length > 2) keys.push({ name: tokens.slice(-2).join("_"), loose: false });
  } else if (tokens.length === 1) {
    keys.push({ name: `${base}_name`, loose: false }); // branch → branch_name
  }
  // polymorphic refs: "ref … can be a commit SHA" → commit_sha
  if (identifier && !BARE.has(tokens.at(-1) ?? "")) {
    for (const word of ["sha", "id", "number"]) {
      if (new RegExp(`\\b${word}\\b`, "i").test(p.description))
        keys.push({ name: `${consumer.resource}_${word}`, loose: false });
    }
  }
  return keys;
}

export type Match = "exact" | "loose" | null;

/**
 * issue_number ↔ issue_number, tasklist_id ↔ task_list_id, pull_number ↔ pull_request_number, hook_id ↔ webhook_id.
 * A stem that is an entity itself (task) is never treated as an abbreviation of a longer one (task_list).
 */
export function fieldMatch(field: OutputField, key: Key, producer: Tool, entities: Set<string>): Match {
  if (compact(field.name) === compact(key.name)) return "exact";
  const i = key.name.lastIndexOf("_");
  if (!key.loose || i <= 0) return null;
  const stem = key.name.slice(0, i);
  const suffix = key.name.slice(i + 1);
  if (!BARE.has(suffix) || field.name !== `${field.entity}_${suffix}`) return null;
  const related =
    !entities.has(stem) && (field.entity.startsWith(`${stem}_`) || compact(field.entity).endsWith(compact(stem)));
  // SEARCH_DOCUMENTS returns Drive files[].id — the listed items are the documents
  const listsStem = field.depth === 1 && compact(producer.resource) === compact(stem);
  return related || listsStem ? "loose" : null;
}

/** GET_CHECK_RUN(check_run_id) → data.id only echoes back an id the caller already had */
const isDetailEcho = (producer: Tool, field: OutputField): boolean =>
  field.depth === 0 &&
  [...producer.required, ...producer.optional].some(
    (r) =>
      compact(r.name) === compact(field.name) || (isIdentifier(r) && compact(r.name).startsWith(compact(field.entity))),
  );

const isLookup = (t: Tool): boolean => t.readOnly || ["LIST", "GET", "SEARCH"].includes(t.verb);

function scoreProducer(
  consumer: Tool,
  producer: Tool,
  field: OutputField,
  match: Match,
  stem: string,
  context: Set<string>,
): number {
  let score = match === "loose" ? 0.8 : 1;
  // embedded in another entity: a PR number inside a workflow run, a review inside an issue event
  if (field.depth >= 2 || (field.depth === 1 && !field.listed)) score *= 0.4;
  if (producer.app !== consumer.app) score *= 0.85; // Google apps share Drive ids

  // same scope wins: repo secrets over org secrets, issue comments over commit comments
  const target = new Set((consumer.resource.endsWith(stem) ? consumer.resource : stem).split("_"));
  const lists = new Set([...producer.resource.split("_"), ...(field.depth === 1 ? field.entity.split("_") : [])]);
  const shared = [...target].filter((t) => lists.has(t)).length;
  score *= 0.5 + (0.5 * shared) / target.size;

  const consumerParams = new Set(consumer.required.map((r) => r.name));
  for (const r of producer.required) {
    if (r.default !== undefined || r.enum) continue;
    if (context.has(r.name))
      score *= consumerParams.has(r.name) ? 1 : 0.7; // needs context the user didn't give
    else score *= isIdentifier(r) ? 0.8 : 0.9; // needs its own lookup first
  }
  return score;
}

function hintedProducers(p: Param, consumer: Tool, bySlug: Map<string, Tool>): Tool[] {
  const prefix = `${consumer.toolkit.toUpperCase()}_`;
  const found: Tool[] = [];
  for (const ref of p.description.match(SLUG_REF) ?? []) {
    const parts = ref.split("_");
    for (let k = 0; k <= parts.length - 2; k++) {
      const tool = bySlug.get(`${prefix}${parts.slice(k).join("_")}`) ?? bySlug.get(parts.slice(k).join("_"));
      if (tool) {
        found.push(tool);
        break;
      }
    }
  }
  return found;
}

function contextParams(tools: Tool[]): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tools) for (const p of t.required) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n / tools.length >= CONTEXT_SHARE).map(([name]) => name));
}

const pick = (t: Tool) => ({ slug: t.slug, toolkit: t.toolkit, app: t.app, verb: t.verb, resource: t.resource });

export async function buildGraph(): Promise<Graph> {
  const tools = await readJson<Tool[]>(dataPath("tools_normalized.json"));
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const entities = new Set(tools.flatMap((t) => [t.resource, ...t.outputs.map((f) => f.entity)]));
  const contextByKit = new Map(
    [...new Set(tools.map((t) => t.toolkit))].map((kit) => [
      kit,
      contextParams(tools.filter((t) => t.toolkit === kit)),
    ]),
  );

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];

  for (const consumer of tools) {
    const context = contextByKit.get(consumer.toolkit) ?? new Set<string>();
    const kitTools = tools.filter((t) => t.toolkit === consumer.toolkit && t !== consumer && isLookup(t));
    const node: GraphNode = { ...pick(consumer), needs: [] };

    for (const p of consumer.required) {
      if (p.default !== undefined || p.enum) continue;
      if (context.has(p.name)) {
        node.needs.push({ param: p.name, kind: "context", producers: [] });
        continue;
      }

      const keys = keysFor(p, consumer);
      const best = new Map<string, Edge>();
      const offer = (edge: Edge) => {
        if ((best.get(edge.from)?.score ?? 0) < edge.score) best.set(edge.from, edge);
      };

      for (const producer of kitTools) {
        if (producer.required.some((r) => r.name === p.name)) continue; // needs the value it would produce
        for (const field of producer.outputs) {
          if (isDetailEcho(producer, field)) continue;
          for (const key of keys) {
            const match = fieldMatch(field, key, producer, entities);
            if (!match) continue;
            const stem = key.name.replace(/_(id|number|sha|slug|name|key)$/, "");
            const score = scoreProducer(consumer, producer, field, match, stem, context);
            offer({ from: producer.slug, to: consumer.slug, param: p.name, score, reason: field.path });
            break;
          }
        }
      }
      for (const producer of hintedProducers(p, consumer, bySlug)) {
        if (producer !== consumer && isLookup(producer)) {
          offer({
            from: producer.slug,
            to: consumer.slug,
            param: p.name,
            score: HINT_SCORE,
            reason: "named in param description",
          });
        }
      }

      const chosen = [...best.values()]
        .filter((e) => e.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PRODUCERS)
        .map((e) => ({ ...e, score: Math.round(e.score * 100) / 100 }));
      const identifier = isIdentifier(p);
      const kind: ParamKind = chosen.length > 0 ? (identifier ? "tool" : "either") : identifier ? "unresolved" : "user";

      node.needs.push({ param: p.name, kind, producers: chosen.map((e) => e.from) });
      edges.push(...chosen);
    }
    nodes.push(node);
  }

  const graph = { nodes, edges };
  await writeJson(dataPath("graph.json"), graph);

  const needs = nodes.flatMap((n) => n.needs);
  const unresolved = needs.filter((r) => r.kind === "unresolved");
  await log("graph", [
    `context params: ${[...contextByKit].map(([kit, set]) => `${kit}=[${[...set].join(", ")}]`).join("  ")}`,
    `param kinds: ${tally(needs, (r) => r.kind)}`,
    `edges: ${edges.length}  nodes with incoming: ${new Set(edges.map((e) => e.to)).size}/${nodes.length}`,
    `edge reasons: ${tally(edges, (e) => (e.reason.startsWith("named") ? "description hint" : "schema match"))}`,
    `top unresolved: ${tally(unresolved, (r) => r.param, 20)}`,
  ]);
  return graph;
}
