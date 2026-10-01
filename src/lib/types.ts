export const TOOLKITS = ["googlesuper", "github"] as const;
export type Toolkit = (typeof TOOLKITS)[number];

export interface Param {
  name: string; // normalized snake_case
  rawName: string;
  type: string;
  description: string;
  default?: unknown;
  enum?: unknown[];
  conditional?: boolean; // optional in schema, but description says it must be provided
}

export interface OutputField {
  name: string; // issue_number
  path: string; // data.issues[].number
  entity: string; // issue (the tool's own resource if top-level)
  depth: number; // entity nesting: 0 = top-level, 2+ = embedded in another entity
}

export interface Tool {
  slug: string;
  title: string;
  toolkit: Toolkit;
  app: string;
  verb: string;
  resource: string;
  description: string;
  required: Param[];
  optional: Param[];
  outputs: OutputField[];
  readOnly: boolean;
  destructive: boolean;
}

export type ParamKind = "context" | "tool" | "either" | "user" | "unresolved";

export interface Requirement {
  param: string;
  kind: ParamKind;
  producers: string[];
}

export interface Edge {
  from: string;
  to: string;
  param: string;
  score: number;
  reason: string;
}

export interface GraphNode extends Pick<Tool, "slug" | "toolkit" | "app" | "verb" | "resource"> {
  needs: Requirement[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}
