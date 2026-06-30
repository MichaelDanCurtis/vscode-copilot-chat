/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PendingEmit } from './surfaceManager';

/**
 * Minimal surface of {@link SurfaceManager} the EMIT BRIDGE needs to drain
 * reserved-but-not-yet-emitted surfaces in the stream-owning handler.
 */
export interface PendingEmitDrain {
	drainPendingEmits(): PendingEmit[];
}

/** Stream shape the bridge replays drained emits onto. */
export interface GenerativeUIStream {
	generativeUI(surfaceId: string, runtimeUri: import('vscode').Uri, initialDoc?: object, version?: number): void;
}

// ---------------------------------------------------------------------------
// Shared-instance accessor
// ---------------------------------------------------------------------------
//
// `RenderA2uiTool` is registered via `vscode.lm.registerTool` in activate()
// with a concrete `SurfaceManager`. That tool's `invoke()` runs WITHOUT a
// `ChatResponseStream` (a Language-Model Tool API constraint), so it can only
// reserve + STASH the surface. The actual `stream.generativeUI(...)` emit must
// run in the tool-calling handler that owns the live stream
// (`buildToolResultElement` in prompts/node/panel/toolCalling.tsx).
//
// Those two sites live in different layers and do not share a DI scope for this
// one object, so we publish the SAME SurfaceManager instance through this tiny
// module-level holder: activate() calls `setA2uiEmitDrain(surfaceManager)`, and
// the handler reads it via `getA2uiEmitDrain()`. This keeps the bridge a small,
// well-located hook instead of threading the manager through the entire
// prompt-rendering call graph.

let _drain: PendingEmitDrain | undefined;

/** Publish the shared SurfaceManager (call once, from activate()). */
export function setA2uiEmitDrain(drain: PendingEmitDrain | undefined): void {
	_drain = drain;
}

/** Resolve the shared SurfaceManager, or `undefined` if A2UI was never wired. */
export function getA2uiEmitDrain(): PendingEmitDrain | undefined {
	return _drain;
}

/**
 * THE BRIDGE: drain every surface the stream-less tool path reserved and replay
 * each through `stream.generativeUI(...)`. Safe no-op when nothing is stashed,
 * the stream is absent, or A2UI was never wired.
 *
 * The `drain` is passed explicitly (kept pure + unit-testable). Call sites that
 * use the shared instance resolve it via {@link getA2uiEmitDrain}; see
 * {@link flushSharedA2uiPendingEmits} for the convenience wrapper.
 */
export function flushA2uiPendingEmits(drain: PendingEmitDrain | undefined, stream: GenerativeUIStream | undefined): void {
	// No stream → do NOT drain. Draining would clear the queue and silently
	// discard the surface; leaving it stashed lets a later round emit it.
	if (!stream || !drain) {
		return;
	}
	for (const e of drain.drainPendingEmits()) {
		stream.generativeUI(e.surfaceId, e.runtimeUri, e.doc, e.version);
	}
}

/** Convenience wrapper: flush using the shared (activate-published) drain. */
export function flushSharedA2uiPendingEmits(stream: GenerativeUIStream | undefined): void {
	flushA2uiPendingEmits(_drain, stream);
}
