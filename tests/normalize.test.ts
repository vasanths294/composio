import { describe, expect, test } from "bun:test";
import { parseSlug, singular, toSnake } from "../src/normalize";

describe("toSnake", () => {
  test.each([
    ["threadId", "thread_id"],
    ["ThreadID", "thread_id"],
    ["HTMLBody", "html_body"],
    ["thread-id", "thread_id"],
  ])("%s → %s", (raw, expected) => expect(toSnake(raw)).toBe(expected));
});

describe("singular", () => {
  test.each([
    ["threads", "thread"],
    ["repositories", "repository"],
    ["branches", "branch"],
    ["addresses", "address"],
    ["status", "status"],
    ["alias", "alias"],
    ["acl", "acl"],
  ])("%s → %s", (word, expected) => expect(singular(word)).toBe(expected));
});

describe("parseSlug", () => {
  test.each([
    ["GOOGLESUPER_REPLY_TO_THREAD", "googlesuper", "REPLY", "thread"],
    ["GOOGLESUPER_FETCH_EMAILS", "googlesuper", "GET", "email"],
    ["GOOGLESUPER_ACL_INSERT", "googlesuper", "CREATE", "acl"],
    ["GITHUB_GET_A_TEAM_BY_NAME", "github", "GET", "team"],
    ["GITHUB_CLOSE_ISSUE", "github", "CLOSE", "issue"],
  ] as const)("%s", (slug, toolkit, verb, resource) => expect(parseSlug(slug, toolkit)).toEqual({ verb, resource }));
});
