/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpClientLike, SnapshotSource } from './mcpDataPipe';

/**
 * Concrete {@link SnapshotSource} implementations that feed the {@link McpDataPipe}.
 *
 * Both sources satisfy the same {@link SnapshotSource} contract, so either drops
 * into `mcpPipe.subscribe(surfaceId, source, name)` identically. The pipe diffs
 * each successive snapshot into a JSON-Patch and emits it as a STATE_DELTA, so a
 * chart bound (`bind`) to the snapshot's state key animates with no interaction.
 *
 *  - {@link IntervalSnapshotSource} — the demo/simulated feed (evolving series).
 *  - {@link McpResourceSnapshotSource} — the REAL path that polls an MCP tool.
 */

// ---------------------------------------------------------------------------
// Timer abstraction (VS Code-safe, injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal timer surface so the unit tests can drive ticks synchronously
 * instead of relying on real wall-clock timers. The default uses Node's
 * `setInterval`/`clearInterval`, which are safe in the VS Code extension host.
 */
export interface TimerLike {
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const realTimer: TimerLike = {
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

// ---------------------------------------------------------------------------
// IntervalSnapshotSource — the demo / simulated feed
// ---------------------------------------------------------------------------

export interface IntervalSnapshotSourceOptions {
	/** State key the chart binds to (the snapshot is `{ [stateKey]: number[] }`). Default `'series'`. */
	readonly stateKey?: string;
	/** Tick interval in milliseconds. Default `1000`. */
	readonly intervalMs?: number;
	/** Number of points kept in the rolling window. Default `24`. */
	readonly windowSize?: number;
	/**
	 * Value generator invoked once per tick. Receives the monotonically
	 * increasing tick index and returns the next data point to push into the
	 * rolling window. Injectable so a test can drive deterministic values.
	 * Default is a sine wave so the demo visibly animates.
	 */
	readonly next?: (tick: number) => number;
	/** Timer implementation (injectable for tests). Default: real `setInterval`. */
	readonly timer?: TimerLike;
}

/**
 * Simulated source that emits an EVOLVING `{ [stateKey]: number[] }` snapshot on
 * every tick. Each tick computes one new value via `next(tick)` and pushes it
 * into a fixed-size rolling window, so a bound chart animates continuously.
 *
 * Deterministic-by-injection: pass `timer` + `next` to drive it synchronously
 * in a unit test (call `tickOnce()` directly — no real timers needed).
 */
export class IntervalSnapshotSource implements SnapshotSource {
	private readonly stateKey: string;
	private readonly intervalMs: number;
	private readonly windowSize: number;
	private readonly next: (tick: number) => number;
	private readonly timer: TimerLike;

	private handler: ((snapshot: unknown) => void) | undefined;
	private handle: unknown;
	private tick = 0;
	private readonly window: number[] = [];
	private disposed = false;

	constructor(options: IntervalSnapshotSourceOptions = {}) {
		this.stateKey = options.stateKey ?? 'series';
		this.intervalMs = options.intervalMs ?? 1000;
		this.windowSize = options.windowSize ?? 24;
		this.timer = options.timer ?? realTimer;
		// Default generator: a smooth sine wave (0..100), so the demo animates.
		this.next = options.next ?? (t => 50 + 45 * Math.sin(t / 3));
	}

	onSnapshot(handler: (snapshot: unknown) => void): void {
		this.handler = handler;
		// Start the timer lazily once a handler is attached. Guard against
		// double-start (the pipe calls onSnapshot exactly once).
		if (this.handle === undefined && !this.disposed) {
			this.handle = this.timer.setInterval(() => this.tickOnce(), this.intervalMs);
		}
	}

	/**
	 * Advance the simulation by one tick and emit the new snapshot. Exposed so
	 * tests can drive the source synchronously without real timers.
	 */
	tickOnce(): void {
		if (this.disposed) {
			return;
		}
		const value = this.next(this.tick++);
		this.window.push(value);
		if (this.window.length > this.windowSize) {
			this.window.shift();
		}
		// Emit a fresh array each tick so the pipe's diff sees the change.
		this.handler?.({ [this.stateKey]: [...this.window] });
	}

	dispose(): void {
		this.disposed = true;
		if (this.handle !== undefined) {
			this.timer.clearInterval(this.handle);
			this.handle = undefined;
		}
		this.handler = undefined;
	}
}

// ---------------------------------------------------------------------------
// McpResourceSnapshotSource — the REAL path
// ---------------------------------------------------------------------------

export interface McpResourceSnapshotSourceOptions {
	/** The MCP client to poll (concrete SDK `Client` or a test double). */
	readonly client: McpClientLike;
	/** The MCP tool/resource name to call each tick. */
	readonly name: string;
	/** Arguments forwarded to `callTool` each poll. Default `{}`. */
	readonly args?: Record<string, unknown>;
	/** Poll interval in milliseconds. Default `1000`. */
	readonly intervalMs?: number;
	/**
	 * Maps a raw `callTool` result into the snapshot object the pipe diffs.
	 * Default forwards the result verbatim (expects the tool to return a plain
	 * object the chart's `bind` key can read). Injectable so callers can adapt
	 * arbitrary MCP payloads into `{ [stateKey]: number[] }`.
	 */
	readonly toSnapshot?: (result: unknown) => unknown;
	/** Timer implementation (injectable for tests). Default: real `setInterval`. */
	readonly timer?: TimerLike;
}

/**
 * REAL source that polls a named MCP tool/resource on an interval and forwards
 * each result as a snapshot. Wraps the same {@link McpClientLike} the pipe's
 * `callTool` uses, so it drops into `subscribe()` exactly like the demo source.
 *
 * This path is only fully exercised when a real MCP server is configured; the
 * unit test drives it with a fake {@link McpClientLike}. Polling is used rather
 * than resource subscriptions because `McpClientLike` only guarantees
 * `callTool`; a subscription-capable client can be adapted behind this same
 * interface without changing the pipe.
 */
export class McpResourceSnapshotSource implements SnapshotSource {
	private readonly client: McpClientLike;
	private readonly name: string;
	private readonly args: Record<string, unknown>;
	private readonly intervalMs: number;
	private readonly toSnapshot: (result: unknown) => unknown;
	private readonly timer: TimerLike;

	private handler: ((snapshot: unknown) => void) | undefined;
	private handle: unknown;
	private disposed = false;

	constructor(options: McpResourceSnapshotSourceOptions) {
		this.client = options.client;
		this.name = options.name;
		this.args = options.args ?? {};
		this.intervalMs = options.intervalMs ?? 1000;
		this.toSnapshot = options.toSnapshot ?? (r => r);
		this.timer = options.timer ?? realTimer;
	}

	onSnapshot(handler: (snapshot: unknown) => void): void {
		this.handler = handler;
		if (this.handle === undefined && !this.disposed) {
			this.handle = this.timer.setInterval(() => { void this.poll(); }, this.intervalMs);
		}
	}

	/**
	 * Poll the MCP tool once and forward the mapped snapshot. Exposed so tests
	 * can await a single poll synchronously without real timers.
	 */
	async poll(): Promise<void> {
		if (this.disposed) {
			return;
		}
		try {
			const result = await this.client.callTool({ name: this.name, arguments: this.args });
			if (this.disposed) {
				return; // disposed mid-flight — drop the late result
			}
			this.handler?.(this.toSnapshot(result));
		} catch {
			// Swallow transient MCP errors; the next tick retries. A throwing
			// poll must not tear down the interval.
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.handle !== undefined) {
			this.timer.clearInterval(this.handle);
			this.handle = undefined;
		}
		this.handler = undefined;
	}
}

// ---------------------------------------------------------------------------
// Factory — build the matching source from a document's live binding
// ---------------------------------------------------------------------------

/** The document-level live binding shape (mirrors `A2uiLiveBinding` in the runtime). */
export interface LiveBinding {
	readonly stateKey: string;
	readonly source: 'demo' | 'mcp';
	readonly name?: string;
	readonly intervalMs?: number;
}

/**
 * Construct the {@link SnapshotSource} matching a document's `live` binding.
 *
 *  - `source: 'demo'` → {@link IntervalSnapshotSource} (always available).
 *  - `source: 'mcp'`  → {@link McpResourceSnapshotSource} when an MCP client is
 *                       available; otherwise falls back to the demo source with
 *                       a logged note (the chart still animates).
 *
 * @param live    The validated live binding from the document root.
 * @param client  The MCP client to use for the real path, or `undefined`.
 * @param log     Optional logger for the demo-fallback note.
 */
export function createLiveSource(
	live: LiveBinding,
	client: McpClientLike | undefined,
	log?: (message: string) => void,
): SnapshotSource {
	if (live.source === 'mcp') {
		if (client && live.name) {
			return new McpResourceSnapshotSource({
				client,
				name: live.name,
				intervalMs: live.intervalMs,
			});
		}
		log?.(`[a2ui] live source 'mcp' requested for '${live.stateKey}' but no MCP client/name is wired; falling back to demo feed.`);
	}
	return new IntervalSnapshotSource({
		stateKey: live.stateKey,
		intervalMs: live.intervalMs,
	});
}
