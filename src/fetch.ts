import { Composio } from "@composio/core";
import { dataPath, exists, writeJson } from "./lib/io";
import { log } from "./lib/log";
import { TOOLKITS } from "./lib/types";

const LIMIT = 1000;

export async function fetchTools(refresh: boolean): Promise<void> {
  let composio: Composio | undefined;
  const lines: string[] = [];

  for (const toolkit of TOOLKITS) {
    const path = dataPath(`${toolkit}_tools.json`);
    if (!refresh && (await exists(path))) {
      lines.push(`${toolkit}: cached`);
      continue;
    }
    composio ??= new Composio();
    const tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: LIMIT });
    if (tools.length === 0) throw new Error(`${toolkit}: no tools returned`);
    await writeJson(path, tools);
    lines.push(`${toolkit}: ${tools.length} tools${tools.length >= LIMIT ? " (hit limit, may be truncated)" : ""}`);
  }

  await log("fetch", lines);
}
