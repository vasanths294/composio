import { expect, test } from "bun:test";
import type { GraphNode } from "../src/lib/types";
import { formatPlan } from "../src/plan";

const node = (slug: string, needs: GraphNode["needs"]): GraphNode => ({
  slug,
  toolkit: "github",
  app: "github",
  verb: "X",
  resource: "x",
  needs,
});

test("asks for context once and chains producers", () => {
  const nodes = new Map(
    [
      node("COMMENT", [
        { param: "owner", kind: "context", producers: [] },
        { param: "body", kind: "user", producers: [] },
        { param: "issue_number", kind: "tool", producers: ["LIST_ISSUES", "SEARCH_ISSUES"] },
      ]),
      node("LIST_ISSUES", [{ param: "owner", kind: "context", producers: [] }]),
    ].map((n) => [n.slug, n]),
  );
  expect(formatPlan("COMMENT", nodes)).toBe(
    [
      "COMMENT",
      "  context (ask once): owner",
      "  - body: ask the user",
      "  - issue_number: call LIST_ISSUES (or SEARCH_ISSUES)",
    ].join("\n"),
  );
});
