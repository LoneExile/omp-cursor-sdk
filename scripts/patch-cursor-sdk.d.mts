export interface PatchCursorSdkTarget {
	/** SDK build directory relative to the package root; every `.js` file under it is searched for `from`. */
	build: string;
	from: string;
	to: string;
	marker: string;
}

export const TARGETS: readonly PatchCursorSdkTarget[];
