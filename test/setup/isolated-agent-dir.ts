// Bun test preload (bunfig.toml): every test run gets a throwaway OMP agent dir.
//
// pi-utils resolves getAgentDir() once at module load (dirs.ts builds its
// DirResolver from PI_CODING_AGENT_DIR on import) and never re-reads the env var,
// so suites that set PI_CODING_AGENT_DIR in beforeEach are too late and write
// cursor-sdk-*.json and models.db into the real ~/.omp/agent. Set the env var
// before pi-utils loads (it also reads <agentDir>/.env on import), then pin it
// with setAgentDir() in case anything imported pi-utils first.
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Dynamic on purpose: a static import would load pi-utils before the env var is set.
const { setAgentDir } = await import("@oh-my-pi/pi-utils");
setAgentDir(agentDir);
// A preload-level afterAll runs once after every test file; bun test does not emit process "exit".
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
