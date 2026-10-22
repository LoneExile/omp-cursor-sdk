import type { SDKAgent } from "@cursor/sdk";
import { asRecord, getArray, getString } from "./cursor-record-utils.js";
import { readCursorSdkTurnUsage, type CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

const BILLED_USAGE_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
		clearTimeout(timer);
	});
}

/** The token counts of the `getUsage().runs[]` row whose `runId` is `runId`, or undefined when there is none or it is unreadable. */
export function selectCursorBilledTurnUsage(agentUsage: unknown, runId: string): CursorSdkTurnUsage | undefined {
	for (const item of getArray(asRecord(agentUsage), "runs") ?? []) {
		const row = asRecord(item);
		if (getString(row, "runId") === runId) return readCursorSdkTurnUsage(row?.usage);
	}
	return undefined;
}

/**
 * Billed token counts of the cloud run `runId`, from `agent.getUsage({ runId })`. Undefined when there is nothing to
 * use: a run id that is not a cloud `run-` id, a failed or timed-out read (`timeoutMs`, 5 s by default), no row for
 * the run, or an unreadable row. It never throws, and the caller then keeps the turn's approximate usage.
 *
 * Cloud only, by decision, and only a finished cloud turn calls it (cursor-provider-turn-finalize.ts). A cloud turn
 * runs on its own fresh agent (cursor-provider-turn-prepare.ts), so the agent's one run is the turn, and the row is
 * selected by the SDK run id (`runs[].runId` is the id `agent.send()` returned, per the API documentation and the
 * captures). Local agents are never read:
 *  - `getUsage()` on a local agent answered 403 `feature_unavailable` on the account used for the capture (the SDK
 *    documents local usage as enabled per account), so no local row was ever observed;
 *  - the SDK describes local entries only as "per-turn groups keyed by usage UUID", and `GetUsageOptions.runId`
 *    takes that UUID, not the run's id, so nothing maps a local run to its row;
 *  - without that mapping every attribution rule either sums history (a resumed local agent returns every turn it
 *    ever had) or double counts (a live run whose bridged tool-use turns already carry their raw turn-ended usage
 *    would also carry the whole run's row on its final message).
 * Local turns keep the raw `turn-ended` usage (see applyCursorUsage), so no local `getUsage()` request is made.
 */
export async function fetchCursorCloudBilledTurnUsage(options: {
	agent: SDKAgent;
	runId: string;
	timeoutMs?: number;
}): Promise<CursorSdkTurnUsage | undefined> {
	const { agent, runId } = options;
	if (!runId.startsWith("run-")) return undefined;
	try {
		const agentUsage = await withTimeout(agent.getUsage({ runId }), options.timeoutMs ?? BILLED_USAGE_TIMEOUT_MS);
		return agentUsage === undefined ? undefined : selectCursorBilledTurnUsage(agentUsage, runId);
	} catch {
		return undefined;
	}
}
