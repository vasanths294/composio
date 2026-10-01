import { fetchTools } from "./fetch";
import { inspectTools } from "./inspect";
import { log } from "./lib/log";
import { normalizeTools } from "./normalize";

const args = new Set(process.argv.slice(2));

try {
  await fetchTools(args.has("--refresh"));
  if (args.has("--inspect")) await inspectTools();
  await normalizeTools();
} catch (err) {
  await log("error", [err instanceof Error ? (err.stack ?? err.message) : String(err)]);
  process.exit(1);
}
