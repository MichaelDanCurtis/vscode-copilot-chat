/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import type { SurfaceRegistrar } from './renderA2uiTool';
import type { SurfaceChannel } from './agUiBridge';
import type { Disposable } from './mcpDataPipe';
import type { LiveBinding } from './dataSources';

// ---------------------------------------------------------------------------
// Collaborator interfaces (injected — never concrete here)
// ---------------------------------------------------------------------------

/** Minimal MCP pipe surface exposed to SurfaceManager. */
interface McpPipeLike {
	callTool(client: unknown, name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * A registered consumer of a surface's host→inset message stream OTHER than the
 * core inset (which is reached through {@link SurfaceManagerDeps.insetTransport}).
 *
 * The canonical implementor is `A2uiPanelHost`, which posts each message to its
 * standalone webview panel. Registering one through {@link SurfaceManager.addView}
 * keeps that panel in sync with the chat: every `post(surfaceId, …)` — including
 * the live-feed STATE_DELTAs and the optimistic interaction echoes — fans out to
 * the inset AND every view, so the panel and the in-bubble inset stay identical.
 */
export interface SurfaceView {
	post(msg: HostToInsetMessage): void;
}

/** Collaborators injected into SurfaceManager. */
export interface SurfaceManagerDeps {
	/** Forwards HostToInsetMessage to the actual inset webview/panel. */
	insetTransport: { post(surfaceId: string, msg: HostToInsetMessage): void };
	/** MCP data pipe — only callTool is needed for interaction routing. */
	mcpPipe: McpPipeLike;
	/** Enqueue an agent turn for a `binding:"agent"` interaction. */
	enqueueAgentTurn(surfaceId: string, interaction: unknown): void;
	/** Resolve the runtime asset URI for a surface (injectable for tests). */
	resolveRuntimeUri(surfaceId: string): Uri;
	/**
	 * Start a live data feed for a surface and return its Disposable, or
	 * `undefined` if no feed should run. Injected at activation: it constructs
	 * the matching SnapshotSource (demo/mcp), subscribes it through the
	 * McpDataPipe (which diffs snapshots into STATE_DELTAs), and returns the
	 * subscription Disposable so `disposeSurface` can tear the feed down.
	 *
	 * Optional so existing tests/wirings that never opt into live feeds need
	 * not provide it.
	 */
	startLiveFeed?(surfaceId: string, live: LiveBinding): Disposable | undefined;
	/**
	 * Open (or reveal + re-render an existing) standalone webview PANEL surface
	 * for the given document. Injected at activation — it constructs/reuses an
	 * `A2uiPanelHost` (which registers itself as a {@link SurfaceView} via
	 * {@link SurfaceManager.addView} so it stays in bidirectional sync with the
	 * chat). Optional, mirroring {@link startLiveFeed}, so non-panel tests and
	 * wirings need not provide it. Called by the render path for documents whose
	 * `target` is `'panel'` or `'both'`.
	 */
	openPanel?(surfaceId: string, doc: object, runtimeUri: Uri): void;
}

// ---------------------------------------------------------------------------
// Internal surface record
// ---------------------------------------------------------------------------

interface SurfaceRecord {
	/** The MCP subscription for this surface. May be absent if bindMcp was never called. */
	mcpSubscription: Disposable | undefined;
	/**
	 * Optimistic interaction-echo state for this surface (Part C.3 seam).
	 * Incremented on every routed interaction; mirrored back to the inset via a
	 * STATE_DELTA so a `bind`-ed text component visibly reflects the click.
	 * Phase 3 (live MCP) will FEED this same state from real tool results.
	 */
	clicks: number;
}

// ---------------------------------------------------------------------------
// Pending-emit record (EMIT BRIDGE — "Option A")
// ---------------------------------------------------------------------------

/**
 * A reserved-but-not-yet-emitted generative-UI surface.
 *
 * `RenderA2uiTool.invoke()` runs in the stream-less Language-Model Tool path:
 * it can validate + reserve the surface but cannot emit the in-bubble inset
 * (no `ChatResponseStream`). It therefore STASHES one of these records, which
 * the stream-owning tool-calling handler later drains and replays through
 * `stream.generativeUI(surfaceId, runtimeUri, doc, version)`.
 */
export interface PendingEmit {
	readonly surfaceId: string;
	readonly runtimeUri: Uri;
	readonly doc: object;
	readonly version: number;
}

// ---------------------------------------------------------------------------
// SurfaceManager
// ---------------------------------------------------------------------------

/**
 * Phase 3 capstone coordinator.
 *
 * Implements SurfaceRegistrar (consumed by RenderA2uiTool) and SurfaceChannel
 * (consumed by AgUiBridge). Owns the lifecycle of each surface: creation,
 * MCP binding, interaction routing, and idempotent teardown.
 *
 * All cross-boundary wiring (concrete insetTransport, real McpDataPipe, etc.)
 * is deferred to the activation task; this class only depends on structural
 * interfaces, making it fully unit-testable with fakes.
 *
 * POST-DISPOSE BEHAVIOUR FOR `post()`:
 * After `disposeSurface(id)` any call to `post(id, …)` is silently dropped.
 * The surface's inset is gone; forwarding messages to a torn-down surface
 * would be a dangling-reference error. Dropping (rather than throwing) mirrors
 * VS Code disposable conventions and keeps callers simple.
 */
export class SurfaceManager implements SurfaceRegistrar, SurfaceChannel {
	private readonly _surfaces = new Map<string, SurfaceRecord>();
	/** Pending-emit records keyed by surfaceId. O(1) targeted drain. */
	private readonly _pendingEmits = new Map<string, PendingEmit>();
	/**
	 * Additional message consumers per surfaceId (panel hosts). The core inset is
	 * NOT in this map — it is reached through `_deps.insetTransport`. `post()` fans
	 * out to both the inset transport and every view here, keeping panel(s) and the
	 * in-bubble inset in lock-step.
	 */
	private readonly _views = new Map<string, Set<SurfaceView>>();

	constructor(private readonly _deps: SurfaceManagerDeps) { }

	// -------------------------------------------------------------------------
	// Multi-view fan-out (panel surfaces)
	// -------------------------------------------------------------------------

	/**
	 * Register an additional {@link SurfaceView} (e.g. a panel host) for a surface
	 * so it receives every subsequent {@link post} alongside the core inset. Returns
	 * a Disposable that removes the view; disposing it more than once is safe, and a
	 * view is also dropped automatically by {@link disposeSurface}.
	 *
	 * Registering does NOT require the surface to be `register()`ed first — a panel
	 * may be opened for a panel-only (`target:'panel'`) document that never created
	 * an inset record. Fan-out in `post()` is independent of the inset record's
	 * presence for views.
	 */
	addView(surfaceId: string, view: SurfaceView): Disposable {
		let set = this._views.get(surfaceId);
		if (!set) {
			set = new Set<SurfaceView>();
			this._views.set(surfaceId, set);
		}
		set.add(view);
		return { dispose: () => this._removeView(surfaceId, view) };
	}

	/** Remove a single view; drops the surface's view set once it is empty. */
	private _removeView(surfaceId: string, view: SurfaceView): void {
		const set = this._views.get(surfaceId);
		if (!set) {
			return;
		}
		set.delete(view);
		if (set.size === 0) {
			this._views.delete(surfaceId);
		}
	}

	// -------------------------------------------------------------------------
	// EMIT BRIDGE — stash / drain
	// -------------------------------------------------------------------------

	/**
	 * Stash a surface that was reserved by the stream-less `RenderA2uiTool.invoke()`
	 * path. The record is replayed by the stream-owning handler via
	 * {@link drainPendingEmit} or {@link drainPendingEmits}.
	 *
	 * Keyed by surfaceId — a second stash for the same id overwrites the first,
	 * which is safe because `register()` is also idempotent per surfaceId.
	 */
	stashPendingEmit(record: PendingEmit): void {
		this._pendingEmits.set(record.surfaceId, record);
	}

	/**
	 * Drain and return the pending emit for a **specific** surfaceId (O(1)).
	 * Returns `undefined` and leaves the map untouched if no record exists.
	 * This is the targeted drain used by the emit bridge to prevent cross-tool
	 * and cross-session emission.
	 */
	drainPendingEmit(surfaceId: string): PendingEmit | undefined {
		const record = this._pendingEmits.get(surfaceId);
		if (record !== undefined) {
			this._pendingEmits.delete(surfaceId);
		}
		return record;
	}

	/**
	 * Return ALL stashed pending emits and clear the map. Returns a fresh array
	 * each call; a second drain (with no intervening stash) returns `[]`.
	 *
	 * Retained for any callers that need a full drain; the emit bridge now uses
	 * the targeted {@link drainPendingEmit} instead.
	 */
	drainPendingEmits(): PendingEmit[] {
		const all = [...this._pendingEmits.values()];
		this._pendingEmits.clear();
		return all;
	}

	// -------------------------------------------------------------------------
	// SurfaceRegistrar
	// -------------------------------------------------------------------------

	/**
	 * Create a surface record and return the runtime asset URI.
	 * Idempotent: registering the same surfaceId twice overwrites the record
	 * (any prior MCP subscription is automatically disposed to avoid leaks).
	 */
	register(surfaceId: string): { runtimeUri: Uri } {
		this._surfaces.get(surfaceId)?.mcpSubscription?.dispose(); // evict prior subscription to avoid leak
		this._surfaces.set(surfaceId, { mcpSubscription: undefined, clicks: 0 });
		return { runtimeUri: this._deps.resolveRuntimeUri(surfaceId) };
	}

	// -------------------------------------------------------------------------
	// SurfaceChannel
	// -------------------------------------------------------------------------

	/**
	 * Forward a HostToInsetMessage to BOTH the core inset transport AND every
	 * registered {@link SurfaceView} (panel host) for this surface.
	 *
	 * - INSET PATH: gated on the surface record — once `disposeSurface` removes it,
	 *   inset forwarding is dropped (a torn-down inset must not be addressed). When
	 *   there is no inset at all (panel-only surface) the transport call is a
	 *   harmless no-op (the `_a2ui.postToSurface` command finds no inset and returns).
	 * - VIEW PATH: each registered view receives the message. Views are managed by
	 *   their own lifecycle (panel disposal removes the view), so they fan out
	 *   whenever any are present, independent of the inset record. This is what
	 *   keeps a standalone panel in sync with the live feed / interaction echoes.
	 */
	post(surfaceId: string, msg: HostToInsetMessage): void {
		if (this._surfaces.has(surfaceId)) {
			this._deps.insetTransport.post(surfaceId, msg);
		}
		const views = this._views.get(surfaceId);
		if (views) {
			// Copy to a snapshot so a view removing itself during post() is safe.
			for (const view of [...views]) {
				view.post(msg);
			}
		}
	}

	// -------------------------------------------------------------------------
	// MCP binding
	// -------------------------------------------------------------------------

	/**
	 * Attach an MCP subscription to a surface. The subscription is disposed
	 * when `disposeSurface` is called.
	 *
	 * Replaces any previously stored subscription without disposing the old one
	 * (caller is responsible for not leaking the previous subscription).
	 */
	bindMcp(surfaceId: string, subscription: Disposable): void {
		const record = this._surfaces.get(surfaceId);
		if (record) {
			record.mcpSubscription = subscription;
		}
	}

	/**
	 * Start a live data feed for a surface IF the rendered document declares a
	 * `live` binding. Called by the render path right after `register()`.
	 *
	 * Delegates source construction + subscription to the injected
	 * {@link SurfaceManagerDeps.startLiveFeed}; the returned Disposable is stored
	 * via {@link bindMcp} so {@link disposeSurface} tears the feed down. No-op
	 * when no `live` binding is present, no feed factory is wired, or the surface
	 * is unknown.
	 *
	 * TIMING: the feed may start before the inset reports READY. That is benign —
	 * the source ticks continuously, so the chart populates within ~1 interval
	 * once the inset is listening. No READY handshake is needed.
	 */
	maybeStartLiveFeed(surfaceId: string, live: LiveBinding | undefined): void {
		if (!live || !this._deps.startLiveFeed) {
			return;
		}
		if (!this._surfaces.has(surfaceId)) {
			return; // unknown/disposed surface
		}
		const subscription = this._deps.startLiveFeed(surfaceId, live);
		if (subscription) {
			this.bindMcp(surfaceId, subscription);
		}
	}

	/**
	 * Open (or reveal + re-render) a standalone webview PANEL for a surface.
	 * Delegates to the injected {@link SurfaceManagerDeps.openPanel}; no-op when
	 * no panel factory is wired (inset-only wirings/tests). Called by the render
	 * path for `target:'panel'`/`'both'` documents.
	 */
	openPanel(surfaceId: string, doc: object, runtimeUri: Uri): void {
		this._deps.openPanel?.(surfaceId, doc, runtimeUri);
	}

	// -------------------------------------------------------------------------
	// Interaction routing
	// -------------------------------------------------------------------------

	/**
	 * Route an interaction event from the inset to the correct back-end, then
	 * post an OPTIMISTIC state echo so the user immediately SEES the click land.
	 *
	 * - `binding === 'mcp'`   → forward to `mcpPipe.callTool`
	 * - `binding === 'agent'` → forward to `enqueueAgentTurn`
	 *
	 * VISIBLE LOOP (Part C.3 seam): after dispatching, this bumps a per-surface
	 * click counter and records the action name, then pushes a STATE_DELTA back to
	 * the inset (`add /clicks`, `add /lastAction` — `add` is add-or-replace, so it
	 * is safe on the first click when the keys are still absent). A `bind`-ed `text`
	 * component re-renders with the new value, closing the round-trip. This is the
	 * exact seam Phase 3 (live MCP) will feed from real tool results — the echo
	 * shape stays, only its source changes.
	 *
	 * @param action Optional action name (from the interaction binding) used for
	 *   the `lastAction` echo; falls back to `componentId` when absent.
	 */
	async routeInteraction(
		surfaceId: string,
		componentId: string,
		binding: 'mcp' | 'agent',
		payload: unknown,
		action?: string,
	): Promise<void> {
		if (binding === 'mcp') {
			// The concrete client / tool-name resolution lives in McpDataPipe;
			// for now we pass the minimal information available here.
			// callTool expects (client, name, args) — we pass the payload as args
			// and use a sentinel client/name so tests can verify the call happened.
			await this._deps.mcpPipe.callTool(
				null,          // concrete client injected at activation time
				componentId,   // component id doubles as tool name for routing
				payload && typeof payload === 'object' && !Array.isArray(payload)
					? (payload as Record<string, unknown>)
					: {},
			);
		} else {
			this._deps.enqueueAgentTurn(surfaceId, { componentId, payload });
		}

		// VISIBLE OPTIMISTIC ECHO: mirror the interaction into surface state so a
		// `bind`-ed display updates. `post()` is a no-op if the surface was disposed.
		this._echoInteraction(surfaceId, action ?? componentId);
	}

	/**
	 * Bump the per-surface click counter, record the last action, and push a
	 * STATE_DELTA to the inset. No-op for an unknown/disposed surface.
	 */
	private _echoInteraction(surfaceId: string, lastAction: string): void {
		const record = this._surfaces.get(surfaceId);
		if (!record) {
			return; // surface disposed or never registered
		}
		record.clicks += 1;
		this.post(surfaceId, {
			type: 'STATE_DELTA',
			surfaceId,
			// `add` (not `replace`): JSON-Patch `add` on an object member is
			// add-or-replace, so it is safe on the FIRST interaction (keys absent)
			// and on every subsequent one. A `replace` would throw under the
			// runtime's validating applyPatch when the key does not yet exist.
			patch: [
				{ op: 'add', path: '/clicks', value: record.clicks },
				{ op: 'add', path: '/lastAction', value: lastAction },
			],
		});
	}

	// -------------------------------------------------------------------------
	// Teardown
	// -------------------------------------------------------------------------

	/**
	 * Tear down a surface. Idempotent — safe to call multiple times.
	 *
	 * 1. Disposes the bound MCP subscription exactly once.
	 * 2. Removes the surface record so subsequent `post()` calls are dropped.
	 */
	disposeSurface(surfaceId: string): void {
		const record = this._surfaces.get(surfaceId);
		if (!record) {
			return; // already disposed or never registered
		}
		// Remove the record BEFORE disposing so re-entrant calls are no-ops.
		this._surfaces.delete(surfaceId);
		record.mcpSubscription?.dispose();
		// Drop any registered views (panel hosts) for this surface so subsequent
		// posts fan out to nobody. The panel host's own onDidDispose still runs
		// independently; this just guarantees the manager holds no stale view refs.
		this._views.delete(surfaceId);
	}
}
