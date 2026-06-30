/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import type { Disposable } from '../node/mcpDataPipe';
import type { SurfaceView } from '../node/surfaceManager';

// ---------------------------------------------------------------------------
// Minimal structural surfaces (injectable — keeps the host unit-testable
// without a real `vscode.window` / WebviewPanel)
// ---------------------------------------------------------------------------

/** The subset of `vscode.Uri` the host needs (an opaque token it forwards). */
export interface UriLike {
	toString(skipEncoding?: boolean): string;
}

/** The subset of `vscode.Webview` the host drives. */
export interface WebviewLike {
	html: string;
	readonly cspSource: string;
	asWebviewUri(localResource: UriLike): UriLike;
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
}

/** The subset of `vscode.WebviewPanel` the host drives. */
export interface WebviewPanelLike {
	readonly webview: WebviewLike;
	reveal(viewColumn?: unknown, preserveFocus?: boolean): void;
	onDidDispose(listener: () => void): { dispose(): void };
	dispose(): void;
}

/** Inbound message shape from the panel webview (mirrors the inset protocol). */
type PanelToHostMessage =
	| { type: 'READY'; surfaceId?: string }
	| { type: 'INTERACTION'; componentId: string; binding: 'mcp' | 'agent'; action?: string; payload: unknown }
	| { type: 'RESIZE'; height?: number };

/** Collaborators injected into {@link A2uiPanelHost}. */
export interface A2uiPanelHostDeps {
	/** The opened webview panel (real `vscode.WebviewPanel` in production; a fake in tests). */
	readonly panel: WebviewPanelLike;
	/** On-disk runtime asset URI; rewritten via `webview.asWebviewUri` for the `<script src>`. */
	readonly runtimeUri: UriLike;
	/** The surface this panel renders. */
	readonly surfaceId: string;
	/** Initial document to render once the webview signals READY. */
	readonly doc: object;
	/** Register this host as a {@link SurfaceView}; the returned Disposable removes it. */
	addView(surfaceId: string, view: SurfaceView): Disposable;
	/** Route an inset/panel interaction to the back-end (bound to SurfaceManager.routeInteraction). */
	routeInteraction(surfaceId: string, componentId: string, binding: 'mcp' | 'agent', payload: unknown, action?: string): unknown;
}

/**
 * Hosts an A2UI surface in a standalone webview PANEL, kept in bidirectional sync
 * with the chat.
 *
 * SYNC MODEL — the host implements {@link SurfaceView} and registers itself through
 * the injected {@link A2uiPanelHostDeps.addView}. From then on every
 * `SurfaceManager.post(surfaceId, …)` (live-feed STATE_DELTAs, interaction echoes,
 * DISPOSE) fans out to this panel's webview via {@link post}, so the panel renders
 * exactly what the inset does. In the reverse direction the panel's own
 * interactions are forwarded through {@link A2uiPanelHostDeps.routeInteraction} —
 * the same entry point core uses for inset interactions — so a click in the panel
 * drives the same MCP/agent dispatch + optimistic echo that a click in the inset
 * would, and the echo then fans back out to both surfaces.
 *
 * LIFECYCLE:
 *  - construct → opens HTML, wires `onDidReceiveMessage`, registers the view.
 *  - webview READY → posts `{type:'RENDER', doc}` (and again on every {@link render}
 *    once READY, so re-rendering an already-open panel repaints it).
 *  - webview INTERACTION → `routeInteraction(surfaceId, componentId, binding, payload, action)`.
 *  - webview RESIZE → ignored (the panel manages its own layout, unlike the inset
 *    which sizes its host row to the content).
 *  - panel onDidDispose → removes the view registration. It deliberately does NOT
 *    call `disposeSurface`: closing one panel must not tear down a live feed that a
 *    still-open inset (or another panel) is consuming. Feed teardown remains owned
 *    by the surface's own `disposeSurface` (inset disposal / re-render).
 *
 * The host depends only on structural interfaces, so tests drive it with a fake
 * webview/panel and never touch the real `vscode.window`.
 */
export class A2uiPanelHost implements SurfaceView {
	private _doc: object;
	private _ready = false;
	private readonly _disposables: { dispose(): void }[] = [];
	private _disposed = false;

	constructor(private readonly _deps: A2uiPanelHostDeps) {
		this._doc = _deps.doc;

		const { webview } = _deps.panel;
		webview.html = this._buildHtml(webview);

		this._disposables.push(
			webview.onDidReceiveMessage(msg => this._onMessage(msg as PanelToHostMessage)),
		);
		// Register as a SurfaceView so host→inset messages fan out to this panel.
		this._disposables.push(_deps.addView(_deps.surfaceId, this));
		// Removing the view + clearing local listeners on panel disposal. We do NOT
		// dispose the surface here (see class doc) — other views/insets may persist.
		this._disposables.push(
			_deps.panel.onDidDispose(() => this.dispose()),
		);
	}

	/**
	 * {@link SurfaceView} — forward a host→inset message to this panel's webview.
	 * No-op once disposed.
	 */
	post(msg: HostToInsetMessage): void {
		if (this._disposed) {
			return;
		}
		this._deps.panel.webview.postMessage(msg);
	}

	/**
	 * Update the document this panel renders and, if the webview has already
	 * signalled READY, re-post RENDER so it repaints immediately. Always reveals
	 * the panel (this is the reuse path for re-opening the same surface).
	 */
	render(doc: object): void {
		if (this._disposed) {
			return;
		}
		this._doc = doc;
		if (this._ready) {
			this._deps.panel.webview.postMessage({ type: 'RENDER', doc: this._doc });
		}
		this._deps.panel.reveal(undefined, true);
	}

	/** Remove the view registration and drop local listeners. Idempotent. */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const d of this._disposables.splice(0)) {
			d.dispose();
		}
	}

	private _onMessage(msg: PanelToHostMessage): void {
		switch (msg.type) {
			case 'READY':
				this._ready = true;
				this._deps.panel.webview.postMessage({ type: 'RENDER', doc: this._doc });
				return;
			case 'INTERACTION':
				this._deps.routeInteraction(
					this._deps.surfaceId,
					msg.componentId,
					msg.binding,
					msg.payload,
					msg.action,
				);
				return;
			case 'RESIZE':
				return; // ignored — the panel sizes itself
		}
	}

	/**
	 * Mirror the core inset HTML/CSP shape (see chatGenerativeUIInsetPart.ts):
	 * strict CSP, a single `<div id="root">`, and the bundled runtime script
	 * loaded through the webview resource authority. No inline handlers / remote
	 * scripts are permitted.
	 */
	private _buildHtml(webview: WebviewLike): string {
		const runtimeSrc = webview.asWebviewUri(this._deps.runtimeUri).toString(true);
		return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline'; img-src ${webview.cspSource} https: data:;">
</head><body><div id="root"></div><script src="${runtimeSrc}"></script></body></html>`;
	}
}
