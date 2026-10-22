// Child of test/helpers/cursor-sdk-offline-agent.ts: loads one @cursor/sdk build entry (argv[2]), calls
// Agent.create for each case in argv[3] (a JSON object of label -> Agent options such as `model` or
// `tools`), and prints the model each local agent resolved or the error Agent.create threw.
// A local agent needs no network to be created; the SDK reads its model catalog from
// CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON when that is set.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, casesJson] = process.argv.slice(2);
const sdk = entry.endsWith(join("dist", "cjs", "index.js"))
	? createRequire(import.meta.url)(entry)
	: await import(pathToFileURL(entry).href);

const cwd = mkdtempSync(join(tmpdir(), "cursor-sdk-offline-agent-"));
const results = {};
for (const [label, options] of Object.entries(JSON.parse(casesJson))) {
	try {
		const agent = await sdk.Agent.create({ apiKey: "crsr_contract_test", ...options, local: { cwd, settingSources: [] } });
		results[label] = { model: agent.model ?? null };
		await agent[Symbol.asyncDispose]();
	} catch (error) {
		results[label] = { error: error instanceof Error ? error.message : String(error) };
	}
}
console.log(`RESULT:${JSON.stringify(results)}`);
process.exit(0);
