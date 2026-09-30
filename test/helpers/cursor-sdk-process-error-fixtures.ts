// Frames of a real ConnectError that @cursor/sdk 1.0.34 raised (Bun, dist/bundled) when its backend reset the
// connection (captured 2026-09-30). The SDK inlines its Node Connect transport, so the transport frames (`G2`,
// `reject`) sit in the SDK's own file; 1.0.32 showed `@connectrpc/connect-node/dist/esm/node-error.js` and
// `node-universal-client.js` there.
export const SDK_BUNDLED_TRANSPORT_FRAMES =
	"    at from (file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:71:24)\n" +
	"    at G2 (file:///repo/node_modules/@cursor/sdk/dist/bundled/index.js:3:1553542)\n" +
	"    at reject (file:///repo/node_modules/@cursor/sdk/dist/bundled/index.js:3:1567006)\n" +
	"    at emitError (node:events:43:23)";

export function makeNodeClosedPipeWriteError(): Error & NodeJS.ErrnoException {
	const error = new Error("write EPIPE") as Error & NodeJS.ErrnoException;
	error.code = "EPIPE";
	error.syscall = "write";
	error.errno = -32;
	error.stack =
		"Error: write EPIPE\n" +
		"    at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:87:19)";
	return error;
}
