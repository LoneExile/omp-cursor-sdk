export interface PatchCursorSdkTarget {
	rel: string;
	from: string;
	to: string;
	marker?: string;
}

export const TARGETS: readonly PatchCursorSdkTarget[];
