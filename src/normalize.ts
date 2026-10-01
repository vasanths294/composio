import { dataPath, readJson, writeJson } from "./lib/io";
import { log, tally } from "./lib/log";
import { type OutputField, type Param, type Tool, type Toolkit, TOOLKITS } from "./lib/types";

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const toSnake = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();

export function singular(w: string): string {
  if (w.length <= 3 || w.endsWith("ss")) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

const VERB_ALIASES: Record<string, string> = {
  FIND: "SEARCH", QUERY: "SEARCH", FETCH: "GET", RETRIEVE: "GET", READ: "GET",
  ADD: "CREATE", INSERT: "CREATE", PATCH: "UPDATE", EDIT: "UPDATE", MODIFY: "UPDATE", REMOVE: "DELETE",
};
const VERBS = new Set([
  ...Object.keys(VERB_ALIASES),
  "LIST", "SEARCH", "GET", "CREATE", "UPDATE", "DELETE", "SEND", "REPLY", "FORWARD", "MOVE",
  "COPY", "UPLOAD", "DOWNLOAD", "EXPORT", "SHARE", "MERGE", "CHECK", "SET", "CLEAR", "WATCH",
  "STOP", "CANCEL", "RUN", "RERUN", "APPROVE", "LOCK", "UNLOCK", "ARCHIVE", "RESTORE", "TRASH",
  "UNTRASH", "RENAME", "REPLACE", "APPEND", "DUPLICATE", "MARK", "ASSIGN", "FOLLOW", "UNFOLLOW",
  "BLOCK", "UNBLOCK", "ENABLE", "DISABLE", "COMPARE", "REVIEW", "DISMISS", "REQUEST", "SUBMIT",
  "VERIFY", "TEST", "EXECUTE", "EMPTY", "STAR", "UNSTAR", "PIN", "UNPIN", "TRANSFER",
]);
const FILLER = new Set(["A", "AN", "THE", "FOR", "OF", "TO", "BY", "IN", "ON", "FROM", "WITH", "AND"]);

export function parseSlug(slug: string): Pick<Tool, "app" | "verb" | "resource"> {
  const tokens = slug.toUpperCase().split("_").filter((t) => t && t !== "GOOGLESUPER");
  const appToken = tokens[0] ?? "UNKNOWN";
  const app = appToken.startsWith("GOOGLE") && appToken.length > 6 ? appToken.slice(6) : appToken;
  const rest = tokens.slice(1);
  const i = rest.findIndex((t) => VERBS.has(t));
  const verb = i >= 0 ? (rest[i] ?? "OTHER") : "OTHER";
  const tail = i >= 0 && i < rest.length - 1 ? rest.slice(i + 1) : rest.filter((_, j) => j !== i);
  const resource = tail
    .filter((t) => !FILLER.has(t))
    .map((t) => singular(t.toLowerCase()))
    .join("_");
  return { app, verb: VERB_ALIASES[verb] ?? verb, resource: resource || "unknown" };
}

function typeOf(p: Json): string {
  if (typeof p.type === "string") return p.type;
  if (Array.isArray(p.type)) return p.type.filter((t) => t !== "null").join("|");
  const variants = p.anyOf ?? p.oneOf;
  if (Array.isArray(variants)) {
    return variants.filter(isObj).map(typeOf).filter((t) => t && t !== "null").join("|");
  }
  return "unknown";
}

function readParams(schema: unknown): { required: Param[]; optional: Param[] } {
  const required: Param[] = [];
  const optional: Param[] = [];
  if (!isObj(schema) || !isObj(schema.properties)) return { required, optional };

  const requiredNames = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [rawName, prop] of Object.entries(schema.properties)) {
    const p = isObj(prop) ? prop : {};
    const param: Param = { name: toSnake(rawName), rawName, type: typeOf(p), description: str(p.description).trim() };
    if (p.default !== undefined && p.default !== null) param.default = p.default;
    if (Array.isArray(p.enum)) param.enum = p.enum;
    (requiredNames.has(rawName) ? required : optional).push(param);
  }
  return { required, optional };
}

const IGNORED_ROOT = new Set(["successful", "successfull", "error", "log_id"]);
const WRAPPERS = new Set(["data", "response", "response_data", "result", "results", "items", "item", "value", "values", "body", "payload", "details"]);
const CONTEXTUAL = new Set(["id", "number", "key", "sha", "name", "login", "email", "url"]);
const MAX_DEPTH = 8;

function walk(node: unknown, root: Json, path: string[], out: string[][], depth: number, refs: Set<string>): void {
  if (!isObj(node) || depth > MAX_DEPTH) return;

  const ref = str(node.$ref);
  if (ref.startsWith("#/")) {
    if (refs.has(ref)) return;
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((cur, key) => (isObj(cur) ? cur[key] : undefined), root);
    walk(target, root, path, out, depth, new Set([...refs, ref]));
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = node[key];
    if (Array.isArray(variants)) for (const v of variants) walk(v, root, path, out, depth + 1, refs);
  }

  if (isObj(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (path.length === 0 && IGNORED_ROOT.has(key)) continue;
      const next = [...path, key];
      out.push(next);
      walk(child, root, next, out, depth + 1, refs);
    }
  }

  const last = path.at(-1);
  if (node.items !== undefined && last !== undefined) {
    walk(node.items, root, [...path.slice(0, -1), `${last}[]`], out, depth + 1, refs);
  }
}

function toFields(segments: string[], resource: string): OutputField[] {
  const path = segments.join(".");
  const names = segments.map((s) => toSnake(s.replace("[]", "")));
  const leaf = names.at(-1);
  if (!leaf) return [];

  const parents = names.slice(0, -1).filter((n) => !WRAPPERS.has(n));
  const parent = parents.at(-1);
  const entity = parent ? singular(parent) : resource;
  const field = (name: string): OutputField => ({ name, path, entity, depth: parents.length });

  const fields = [field(leaf)];
  if (parent && CONTEXTUAL.has(leaf) && !leaf.startsWith(entity)) fields.push(field(`${entity}_${leaf}`));
  if (parent && leaf === "login") fields.push(field(entity));
  return fields;
}

function readOutputs(schema: unknown, resource: string): OutputField[] {
  if (!isObj(schema)) return [];
  const paths: string[][] = [];
  walk(schema, schema, [], paths, 0, new Set());

  const joined = paths.map((p) => p.join("."));
  const isLeaf = (p: string) => !joined.some((q) => q.startsWith(`${p}.`) || q.startsWith(`${p}[]`));
  const leaves = paths.filter((p) => isLeaf(p.join(".")));

  const seen = new Set<string>();
  return leaves
    .flatMap((p) => toFields(p, resource))
    .filter((f) => !seen.has(`${f.name}@${f.path}`) && seen.add(`${f.name}@${f.path}`));
}

function normalizeTool(raw: Json, toolkit: Toolkit): Tool | null {
  const slug = str(raw.slug);
  if (!slug || raw.isDeprecated === true) return null;

  const { app, verb, resource } = parseSlug(slug);
  const { required, optional } = readParams(raw.inputParameters);
  return {
    slug,
    title: str(raw.name),
    toolkit,
    app,
    verb,
    resource,
    description: str(raw.description).trim(),
    required,
    optional,
    outputs: readOutputs(raw.outputParameters, resource),
  };
}

export async function normalizeTools(): Promise<Tool[]> {
  const tools: Tool[] = [];
  const lines: string[] = [];

  for (const toolkit of TOOLKITS) {
    const raw = await readJson<unknown[]>(dataPath(`${toolkit}_tools.json`));
    const kit = raw
      .filter(isObj)
      .map((t) => normalizeTool(t, toolkit))
      .filter((t): t is Tool => t !== null);
    tools.push(...kit);

    const required = kit.flatMap((t) => t.required);
    const share = (name: string) => `${Math.round((100 * required.filter((p) => p.name === name).length) / kit.length)}%`;
    const topRequired = tally(required, (p) => p.name, 25)
      .split("  ")
      .map((e) => `${e}(${share(e.split(":")[0] ?? "")})`)
      .join("  ");

    lines.push(
      `### ${toolkit}: ${kit.length} tools (${raw.length - kit.length} deprecated/invalid skipped)`,
      `apps: ${tally(kit, (t) => t.app)}`,
      `verbs: ${tally(kit, (t) => t.verb)}`,
      `no verb: ${kit.filter((t) => t.verb === "OTHER").slice(0, 8).map((t) => t.slug).join(", ") || "none"}`,
      `outputs: ${tally(kit, (t) => (t.outputs.length === 0 ? "none" : t.outputs.length <= 3 ? "thin(1-3)" : "rich(4+)"))}`,
      `top required (share of tools): ${topRequired}`,
    );
  }

  await writeJson(dataPath("tools_normalized.json"), tools);
  await log("normalize", lines);
  return tools;
}
