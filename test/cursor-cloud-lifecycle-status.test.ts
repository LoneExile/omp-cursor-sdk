import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CLOUD_LIFECYCLE_ENTRY_TYPE, formatCursorCloudLifecycleList } from "../src/cursor-cloud-lifecycle.js";

const AGENT = "bc-00000000-0000-0000-0000-000000000001";

/** One ledger entry for AGENT; `at` is the time the plugin's clock reported when it wrote the entry. */
function ledger(action: string, at: string): SessionEntry {
	return {
		type: "custom",
		id: `${action}-${at}`,
		parentId: null,
		timestamp: at,
		customType: CLOUD_LIFECYCLE_ENTRY_TYPE,
		data: { action, runtime: "cloud", agentId: AGENT, timestamp: at, ...(action === "record" ? { branches: [] } : {}) },
	};
}

describe("Cursor cloud lifecycle status", () => {
	it("keeps a recorded archive final when the clock moved backward during the request", () => {
		const report = formatCursorCloudLifecycleList([
			ledger("record", "2026-07-07T00:00:00.000Z"),
			ledger("archive_intent", "2026-07-07T00:05:00.000Z"),
			// The result is written after the intent, but with an earlier wall-clock time.
			ledger("archive", "2026-07-07T00:04:00.000Z"),
		]);

		expect(report).toContain(`${AGENT} (archived)`);
		expect(report).not.toContain("pending");
	});

	it("hides an agent whose delete result predates its intent and shows an archived agent's unresolved delete", () => {
		expect(formatCursorCloudLifecycleList([
			ledger("record", "2026-07-07T00:00:00.000Z"),
			ledger("delete_intent", "2026-07-07T00:05:00.000Z"),
			ledger("delete", "2026-07-07T00:04:00.000Z"),
		])).not.toContain(AGENT);

		expect(formatCursorCloudLifecycleList([
			ledger("record", "2026-07-07T00:00:00.000Z"),
			ledger("archive_intent", "2026-07-07T00:01:00.000Z"),
			ledger("archive", "2026-07-07T00:02:00.000Z"),
			ledger("delete_intent", "2026-07-07T00:03:00.000Z"),
		])).toContain(`${AGENT} (archived, delete pending)`);
	});
});
