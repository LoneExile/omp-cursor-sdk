import { installCursorSpawnFdGuard } from "./cursor-spawn-fd-guard.js";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { registerCursorRuntimeControls } from "./cursor-state.js";
import { registerCursorNativeToolDisplay } from "./cursor-native-tool-display-registration.js";
import { registerCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { registerCursorQuestionTool } from "./cursor-question-tool.js";
import { registerCursorSkillTool } from "./cursor-skill-tool.js";
import { registerCursorSessionScope } from "./cursor-session-scope.js";
import { registerCursorSessionAgentLifecycle } from "./cursor-session-agent-lifecycle.js";
import { registerCursorSessionAgentLineage } from "./cursor-session-agent-lineage.js";
import { registerCursorSessionAgentResume } from "./cursor-session-agent-resume.js";
import { streamCursorLazy } from "./cursor-provider-lazy.js";
import { streamCursorInBinding } from "./cursor-provider.js";
import { CURSOR_API_KEY_CONFIG_VALUE, resolveCursorApiKey } from "./cursor-api-key.js";
import { CURSOR_PROVIDER, CURSOR_SDK_API } from "./cursor-model.js";
import { registerCursorFallbackIssueWarning } from "./cursor-fallback-warning.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context-registration.js";
import { registerCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { registerCursorConversationTracking } from "./cursor-one-shot-request.js";
import {
	bindCursorExtensionApi,
	createCursorSessionBinding,
	markCursorSessionBindingClosed,
	markCursorSessionBindingStarted,
	runInCursorSessionBinding,
	type CursorSessionBinding,
} from "./cursor-session-binding.js";

type CursorExtensionApi =
	& Pick<ExtensionAPI, "registerProvider" | "registerCommand" | "on">
	& Parameters<typeof registerCursorSessionScope>[0]
	& Parameters<typeof registerCursorSessionAgentLifecycle>[0]
	& Parameters<typeof registerCursorSessionAgentLineage>[0]
	& Parameters<typeof registerCursorSessionAgentResume>[0]
	& Parameters<typeof registerCursorRuntimeControls>[0]
	& Parameters<typeof registerCursorNativeToolDisplay>[0]
	& Parameters<typeof registerCursorQuestionTool>[0]
	& Parameters<typeof registerCursorSkillTool>[0]
	& Parameters<typeof registerCursorPiToolBridge>[0]
	& Parameters<typeof registerCursorFallbackIssueWarning>[0]
	& Parameters<typeof registerCursorAgentsContextDedup>[0]
	& Parameters<typeof registerCursorSdkSessionProcessErrorGuard>[0]
	& Parameters<typeof registerCursorConversationTracking>[0];

function createCursorProviderConfig(models: ProviderModelConfig[]): ProviderConfig {
	return {
		baseUrl: "https://cursor.com",
		// OMP installs a registered apiKey as the provider's config key
		// (ModelRegistry.registerProvider -> authStorage.keys.setConfig), and
		// KeyCascade.source() reports config keys, so the provider is listed as
		// available without stored auth. The real key resolves at turn time.
		apiKey: CURSOR_API_KEY_CONFIG_VALUE,
		api: CURSOR_SDK_API,
		models,
		streamSimple: streamCursorLazy,
	};
}

function registerCursorProvider(pi: Pick<ExtensionAPI, "registerProvider">, models: ProviderModelConfig[]): void {
	pi.registerProvider(CURSOR_PROVIDER, createCursorProviderConfig(models));
}

export default async function (hostPi: CursorExtensionApi) {
	// One binding per registration: the root session's, or a subagent's re-bind of the
	// same module (see cursor-session-binding.ts). Everything below, and every callback
	// the host invokes later, runs inside it, and so does every provider call of its
	// session, whichever module instance's provider receives it.
	const binding = createCursorSessionBinding(streamCursorInBinding);
	const pi = bindCursorExtensionApi(hostPi, binding);
	await runInCursorSessionBinding(binding, () => registerCursorExtension(pi, binding));
}

async function registerCursorExtension(pi: CursorExtensionApi, binding: CursorSessionBinding): Promise<void> {
	installCursorSpawnFdGuard();
	pi.on("session_start", (_event, ctx) => {
		markCursorSessionBindingStarted(binding, ctx.sessionManager?.getSessionId?.() ?? undefined, ctx.agent?.kind);
	});
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionScope(pi);
	registerCursorSessionAgentLineage(pi);
	registerCursorSessionAgentLifecycle(pi);
	registerCursorSessionAgentResume(pi);
	registerCursorConversationTracking(pi);
	// No session_before_compact handler: its presence alone turns off omp's speculative
	// compaction for every session in the process. Summarizer and other host side
	// requests are recognized per request and run on a one-shot agent
	// (cursor-one-shot-request.ts).
	registerCursorRuntimeControls(pi);
	registerCursorNativeToolDisplay(pi);
	registerCursorQuestionTool(pi);
	registerCursorSkillTool(pi);
	registerCursorPiToolBridge(pi);
	registerCursorAgentsContextDedup(pi);
	let fallbackIssue: CursorModelFallbackIssue | undefined;
	const models = await discoverModels({
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	if (fallbackIssue) {
		registerCursorFallbackIssueWarning(pi, fallbackIssue);
	}

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor model catalog without restarting pi",
		handler: async (_args, ctx) => {
			let refreshFallbackIssue: CursorModelFallbackIssue | undefined;
			// Own provider id only: the built-in `cursor` provider's credential is an OMP
			// OAuth access token, not the Cursor SDK API key.
			const apiKey = resolveCursorApiKey(await ctx.modelRegistry.getApiKeyForProvider(CURSOR_PROVIDER));
			const refreshedModels = await discoverModels({
				apiKey,
				forceRefresh: true,
				onFallback: (issue) => {
					refreshFallbackIssue = issue;
				},
			});
			registerCursorProvider(pi, refreshedModels);
			if (!ctx.hasUI) return;
			if (refreshFallbackIssue) {
				ctx.ui.notify(`Cursor model catalog refresh did not use a live catalog: ${refreshFallbackIssue.message}`, "warning");
			} else {
				ctx.ui.notify(`Cursor model catalog refreshed with ${refreshedModels.length} model${refreshedModels.length === 1 ? "" : "s"}.`, "info");
			}
		},
	});

	registerCursorProvider(pi, models);
	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
	pi.on("session_shutdown", () => {
		markCursorSessionBindingClosed(binding);
	});
}
