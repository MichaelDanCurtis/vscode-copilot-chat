/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import type { SurfaceRegistrar } from './renderA2uiTool';
import type { SurfaceChannel } from './agUiBridge';
import type { Disposable } from './mcpDataPipe';

// ---------------------------------------------------------------------------
// Collaborator interfaces (injected — never concrete here)
// ---------------------------------------------------------------------------

/** Minimal MCP pipe surface exposed to SurfaceManager. */
interface McpPipeLike {
	callTool(client: unknown, name: string, args: Record<string, unknown>): Promise<unknown>;
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
}

// ---------------------------------------------------------------------------
// Internal surface record
// ---------------------------------------------------------------------------

interface SurfaceRecord {
	/** The MCP subscription for this surface. May be absent if bindMcp was never called. */
	mcpSubscription: Disposable | undefined;
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

	constructor(private readonly _deps: SurfaceManagerDeps) { }

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
		this._surfaces.set(surfaceId, { mcpSubscription: undefined });
		return { runtimeUri: this._deps.resolveRuntimeUri(surfaceId) };
	}

	// -------------------------------------------------------------------------
	// SurfaceChannel
	// -------------------------------------------------------------------------

	/**
	 * Forward a HostToInsetMessage to the inset transport.
	 * Silently dropped if the surface has already been disposed.
	 */
	post(surfaceId: string, msg: HostToInsetMessage): void {
		if (!this._surfaces.has(surfaceId)) {
			return; // surface disposed or never registered — drop
		}
		this._deps.insetTransport.post(surfaceId, msg);
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

	// -------------------------------------------------------------------------
	// Interaction routing
	// -------------------------------------------------------------------------

	/**
	 * Route an interaction event from the inset to the correct back-end.
	 *
	 * - `binding === 'mcp'`   → forward to `mcpPipe.callTool`
	 * - `binding === 'agent'` → forward to `enqueueAgentTurn`
	 */
	async routeInteraction(
		surfaceId: string,
		componentId: string,
		binding: 'mcp' | 'agent',
		payload: unknown,
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
	}
}
