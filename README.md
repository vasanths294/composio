# Tool dependency graph · Google Super & GitHub

For every Composio tool, this graph answers the question an agent faces before calling it: **which inputs must come from the user, and which can be obtained by calling another tool first?**

```
$ bun run plan GOOGLESUPER_SEND_EMAIL
GOOGLESUPER_SEND_EMAIL
  - body: ask the user
  - subject: ask the user
  - recipient_email: ask the user, or call GOOGLESUPER_SEARCH_PEOPLE (or …)
    - query: ask the user
```

**Open `graph.html` in a browser** to explore it. It's a single self-contained file.

## Results

| | |
|---|---|
| Tools | 1,333 (459 Google Super + 874 GitHub; deprecated tools skipped) |
| Edges | 1,933 (1,612 from schemas and descriptions + 321 resolved by the LLM) |
| Tuning eval | **27/27 required edges, 0 forbidden edges, all hard checks pass** |
| Held-out eval | **12/13 required edges, 0 forbidden edges.** Written after tuning and never tuned against |
| Unit tests | 24 (naming rules, field matching, planning) |

## Run

```bash
bun install
COMPOSIO_API_KEY=... sh scaffold.sh   # writes .env with Composio + OpenRouter keys
bun start                             # fetch → normalize → graph → LLM refine → graph.html → eval
bun run plan GITHUB_MERGE_A_PULL_REQUEST
bun test && bun run lint && bun run typecheck
```

`bun start` flags: `--refresh` refetches the schemas, `--inspect` logs a raw schema snapshot, and `--no-llm` skips the LLM step.

Tool schemas (`data/*_tools.json`) and every LLM reply (`data/llm_cache.json`) are committed, so the pipeline reruns offline with identical output and no API key needed. The run exits with code 1 if the tuning eval fails.

## Outputs

- **`graph.html`:** interactive graph. Filter by app, click a tool to see what it needs and feeds, click an edge to see why it exists, and use "Show precursor chain" to see everything an agent may need to call first.
- **`data/graph.json`:** nodes with each required param's `kind` and producers, plus edges with `from`, `to`, `param`, `score`, and `reason`.
- **`src/plan.ts`:** turns the graph into an execution plan: what to ask the user (shared context once), and which tool to call first, recursively.

## Approach

Deterministic rules first, then the LLM only for what the rules can't settle.

1. **Normalize** each tool: verb and resource from the slug, app from its OAuth scopes (Google Super slugs carry no app name), required params, and every output field flattened with its **entity**, its **depth**, and whether it's a **list item** or a nested sub-object. `data.issues[].number` becomes `issue_number` (entity `issue`, listed). Params that are optional in the schema but required by their description ("at least one of to/cc/bcc") count as required.
2. **Classify each required param:**
   - `context`: required by ≥20% of a toolkit's tools (`owner`, `repo`, `org`). Asked once from the user rather than drawn as hundreds of edges. Detected from the data, not hardcoded.
   - `tool`: an identifier another tool can supply.
   - `either`: a name, email, or slug the user may type or a tool may look up.
   - `user`: free content such as `body`, `title`, or `query`.
3. **Match params to output fields** with entity-aware naming: `pull_number` ↔ `pull_request_number`, `tasklist_id` ↔ `task_list_id`, `hook_id` ↔ `webhook_id`, and polymorphic refs ("ref can be a commit SHA" → `commit_sha`). Producer names written in descriptions ("from GMAIL_LIST_DRAFTS") also count. A stem that is itself an entity (`task`) is never read as an abbreviation of a longer one (`task_list`).
4. **Score each producer.** Only read-only tools qualify. Penalties apply when:
   - the value is embedded in another entity (a PR number inside a workflow run, a review inside an issue event),
   - the producer is in the wrong scope (org secrets for a repo secret),
   - the producer needs context the user didn't give,
   - the producer needs its own lookups first,
   - or the producer is a detail tool that only echoes back an ID you already passed in.
   
   Each param keeps at most 3 producers scoring ≥0.65.
5. **LLM refinement** (`openai/gpt-4o-mini` via OpenRouter) runs only for the ~225 identifiers that are still unresolved, plus email params. Each tool gets one call, with a keyword-ranked shortlist of 12 candidates. The model can only choose from that shortlist, and replies are validated with zod, retried once if malformed, and cached. This step covers what schemas can't express, such as contact search returning an untyped `results` object, which is needed for the readme's own example: a name → `SEARCH_PEOPLE` → `SEND_EMAIL`.
6. **Evaluate** with two hand-written sets of real slugs, each containing edges that must exist, edges that must not exist, params that must stay user input, and tools that must have no precursors. Invariants are also checked: no self-loops, and no destructive tool as a producer.
   - **`eval/ground_truth.json`** was used while developing the rules, and it gates the run.
   - **`eval/held_out.json`** was written and committed after tuning, then evaluated once. It's reported but never tuned against, so its score shows how well the rules generalize.

## Design decisions

- **The rules have to generalize.** No per-tool tables. Every rule is about structure: field depth, list-vs-object, entity names, verbs, read-only hints, and parameter frequency.
- **A schema match isn't enough.** Many fields named `number` or `id` exist, and only the right entity, listed at the right depth, counts. Most of the scoring work is about suppressing plausible-looking but wrong edges.
- **The eval drove every change.** Each rule was added to fix a specific eval failure or a false positive found in a random sample, then rechecked so nothing regressed. The unit tests pin down the naming rules, and they caught a real bug (`singular("status")` returned `"statu"`).
- **The LLM is constrained and auditable.** It handles about 17% of the edges, every one is marked `llm:` with a reason, and the cache makes runs reproducible.

## Limitations

- **Held-out miss:** `CREATE_A_PULL_REQUEST.head` (a branch name) isn't linked to `LIST_BRANCHES`. A bare word like `head` gives the rules no clue that it refers to a branch. It's left unfixed on purpose, because fixing it would mean tuning against the held-out set.
- **About 40 identifiers remain unresolved.** Most have no listing tool in the catalog (e.g. `discussion_number` is only reachable through GraphQL tools with untyped outputs).
- **Lower-ranked LLM producers can be loose.** For example, `SEND_EMAIL.recipient_email` also lists `LIST_SEND_AS`, which returns sender aliases. The top-ranked producer is the one `plan` uses.
- **Precision outside the eval sets** comes from hand-checked random samples (~85–90%), not from a labeled benchmark.
- **Cross-toolkit edges** (e.g. a GitHub user's email → Gmail) aren't modeled, and producer weights are heuristics tuned on this catalog, not learned.

## Layout

```
src/
  index.ts      pipeline entry point
  fetch.ts      Composio raw schemas → data/<toolkit>_tools.json
  inspect.ts    one-off raw schema report (--inspect)
  normalize.ts  slugs, params, flattened output fields → data/tools_normalized.json
  graph.ts      param classification, matching, scoring → data/graph.json
  refine.ts     LLM resolution of the leftovers (cached)
  plan.ts       execution plan for one tool (CLI)
  eval.ts       tuning + held-out ground-truth checks
  viz.ts/.html  graph.html generator and template
  lib/          types, file helpers, run logger
tests/          unit tests (bun test)
eval/           ground_truth.json (tuning), held_out.json
TASK.md         original task description
```
