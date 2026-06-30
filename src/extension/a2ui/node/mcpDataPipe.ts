/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { compare } from 'fast-json-patch';
import { AgUiBridge } from './agUiBridge';

/**
 * Minimal interface for an injectable snapshot source.
 *
 * Design: callback-based rather than async-iterator so that:
 *   1. Tests can drive it synchronously with zero async ceremony.
 *   2. Disposal is explicit — `dispose()` on the source tears down the
 *      underlying subscription (e.g. MCP resource subscription).
 *
 * `onSnapshot` registers the handler that will be invoked for every
 * new snapshot arriving from the MCP server.  Only one handler is
 * supported per source; calling it again replaces the previous one.
 */
export interface SnapshotSource {
	onSnapshot(handler: (snapshot: unknown) => void): void;
	dispose(): void;
}

/**
 * Minimal injectable interface for the MCP client used by `callTool`.
 * Accepts the concrete `Client` from `@modelcontextprotocol/sdk` or a test double.
 */
export interface McpClientLike {
	callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/** VS Code–style disposable returned by `subscribe`. */
export interface Disposable {
	dispose(): void;
}

/**
 * MCP data pipe — Task 3.5.
 *
 * Subscribes to a `SnapshotSource`, diffs each successive snapshot against
 * the previous one using `fast-json-patch`, and forwards non-empty patches
 * to the AG-UI bridge as STATE_DELTA messages.
 *
 * First-snapshot behaviour: the baseline is an empty object `{}`.  The very
 * first snapshot therefore produces a patch from `{}` → snapshot, which is
 * forwarded if non-empty.  This is the simplest well-defined behaviour and
 * lets the inset surface start from a known empty state without requiring
 * a separate "initialise" message.
 *
 * Also exposes `callTool` for `binding:"mcp"` interactions (Task 3.6).
 */
export class McpDataPipe {
	constructor(private readonly bridge: AgUiBridge) { }

	/**
	 * Subscribe to a snapshot source for a given surface.
	 *
	 * @param surfaceId   The target inset surface identifier.
	 * @param source      An injectable snapshot source (real or test double).
	 * @param _toolOrResource  The MCP tool/resource name (stored for future routing; not used in diffing).
	 * @returns A Disposable that, when disposed, tears down the source and
	 *          stops forwarding further snapshots.
	 */
	subscribe(surfaceId: string, source: SnapshotSource, _toolOrResource: string): Disposable {
		let lastSnapshot: Record<string, unknown> = {};
		let active = true;

		source.onSnapshot(rawSnapshot => {
			if (!active) {
				return;
			}

			// MCP boundary guard: only accept plain objects.
			if (!isPlainObject(rawSnapshot)) {
				// Drop malformed snapshot; do not throw.
				return;
			}

			try {
				const next = rawSnapshot as Record<string, unknown>;
				const patch = compare(lastSnapshot, next);
				if (patch.length > 0) {
					this.bridge.emitStateDelta(surfaceId, patch);
				}
				lastSnapshot = next;
			} catch {
				// Guard against any unexpected compare() error (e.g. circular refs).
			}
		});

		return {
			dispose() {
				active = false;
				source.dispose();
			},
		};
	}

	/**
	 * Forward a tool call to the MCP client.
	 * Used by Task 3.6's `routeInteraction` for `binding:"mcp"` events.
	 */
	async callTool(
		client: McpClientLike,
		name: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		return client.callTool({ name, arguments: args });
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for plain objects (not arrays, null, primitives, etc.). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
