/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Uri } from 'vscode';
import type { Disposable } from '../node/mcpDataPipe';
import type { SurfaceView } from '../node/surfaceManager';
import { A2uiPanelHost } from './a2uiPanelHost';

/** Collaborators the registry needs from the SurfaceManager (kept structural for testing). */
export interface A2uiPanelRegistryDeps {
	/** Bound to `SurfaceManager.addView`. */
	addView(surfaceId: string, view: SurfaceView): Disposable;
	/** Bound to `SurfaceManager.routeInteraction`. */
	routeInteraction(surfaceId: string, componentId: string, binding: 'mcp' | 'agent', payload: unknown, action?: string): unknown;
}

/**
 * Per-surfaceId registry of open {@link A2uiPanelHost}s plus the activation-time
 * `openPanel` implementation.
 *
 * REUSE: re-opening the same surfaceId REVEALS + re-renders the existing panel
 * instead of spawning a duplicate. The first open creates the webview panel; an
 * `onDidDispose` handler evicts the host from the map so a later open re-creates it.
 *
 * Returns `{ openPanel, dispose }`. `openPanel` is wired onto `SurfaceManagerDeps`
 * (it matches that optional dep's signature). `dispose` closes all open panels and
 * is pushed into `context.subscriptions`.
 */
export function createA2uiPanelRegistry(deps: A2uiPanelRegistryDeps): {
	openPanel(surfaceId: string, doc: object, runtimeUri: Uri): void;
	dispose(): void;
} {
	const hosts = new Map<string, A2uiPanelHost>();

	const openPanel = (surfaceId: string, doc: object, runtimeUri: Uri): void => {
		// REUSE: reveal + re-render an already-open panel for this surface.
		const existing = hosts.get(surfaceId);
		if (existing) {
			existing.render(doc);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'a2uiPanel',
			`A2UI: ${surfaceId}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(runtimeUri, '..')],
			},
		);

		const host = new A2uiPanelHost({
			panel,
			runtimeUri,
			surfaceId,
			doc,
			addView: deps.addView,
			routeInteraction: deps.routeInteraction,
		});
		hosts.set(surfaceId, host);

		// Evict on disposal so a subsequent open re-creates the panel rather than
		// reusing a closed one. (A2uiPanelHost also wires its own onDidDispose to
		// drop the view registration; this handler manages the registry map.)
		panel.onDidDispose(() => {
			if (hosts.get(surfaceId) === host) {
				hosts.delete(surfaceId);
			}
		});
	};

	const dispose = (): void => {
		for (const host of hosts.values()) {
			host.dispose();
		}
		hosts.clear();
	};

	return { openPanel, dispose };
}
