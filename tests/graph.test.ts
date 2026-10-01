import { describe, expect, test } from "bun:test";
import { fieldMatch } from "../src/graph";
import type { OutputField, Tool } from "../src/lib/types";

const field = (name: string, entity: string, depth = 1): OutputField => ({
  name,
  path: `data.${entity}s[].x`,
  entity,
  depth,
  listed: true,
});
const producer = { resource: "thing" } as Tool;
const noEntities = new Set<string>();

describe("fieldMatch", () => {
  test("same name", () =>
    expect(fieldMatch(field("thread_id", "thread"), { name: "thread_id", loose: false }, producer, noEntities)).toBe(
      "exact",
    ));
  test("underscores ignored", () =>
    expect(
      fieldMatch(field("task_list_id", "task_list"), { name: "tasklist_id", loose: true }, producer, noEntities),
    ).toBe("exact"));
  test("abbreviated entity", () =>
    expect(
      fieldMatch(
        field("pull_request_number", "pull_request"),
        { name: "pull_number", loose: true },
        producer,
        noEntities,
      ),
    ).toBe("loose"));
  test("entity suffix", () =>
    expect(fieldMatch(field("webhook_id", "webhook"), { name: "hook_id", loose: true }, producer, noEntities)).toBe(
      "loose",
    ));
  test("stem that is an entity is not an abbreviation", () =>
    expect(
      fieldMatch(field("task_list_id", "task_list"), { name: "task_id", loose: true }, producer, new Set(["task"])),
    ).toBeNull());
  test("strict keys never match loosely", () =>
    expect(
      fieldMatch(field("branch_policy_id", "branch_policy"), { name: "branch_id", loose: false }, producer, noEntities),
    ).toBeNull());
  test("search tool listing documents as files", () =>
    expect(
      fieldMatch(
        field("file_id", "file"),
        { name: "document_id", loose: true },
        { resource: "document" } as Tool,
        noEntities,
      ),
    ).toBe("loose"));
});
