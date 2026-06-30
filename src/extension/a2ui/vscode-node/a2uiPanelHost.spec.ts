/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import { A2uiPanelHost, type UriLike, type WebviewLike, type WebviewPanelLike } from './a2uiPanelHost';

// ---------------------------------------------------------------------------
// Fake webview / panel (no real vscode.window)
// ---------------------------------------------------------------------------

const FAKE_URI: UriLike = { toString: () => 'file:///runtime.iife.js' };

function makeFakePanel() {
	let messageListener: ((msg: any) => void) | undefined;
	let disposeListener: (() => void) | undefined;

	const webview: WebviewLike = {
		html: '',
		cspSource: 'vscode-resource://fake',
		asWebviewUri: (u: UriLike) => ({ toString: () => `webview:${u.toString()}` }),
		postMessage: vi.fn().mockResolvedValue(true),
		onDidReceiveMessage: (listener: (msg: any) => void) => {
			messageListener = listener;
			return { dispose: vi.fn() };
		},
	};

	const panel: WebviewPanelLike = {
		webview,
		reveal: vi.fn(),
		onDidDispose: (listener: () => void) => {
			disposeListener = listener;
			return { dispose: vi.fn() };
		},
		dispose: vi.fn(),
	};

	return {
		panel,
		webview,
		emit: (msg: unknown) => messageListener?.(msg),
		fireDispose: () => disposeListener?.(),
	};
}

const DOC = { surfaceId: 'surf-1', version: 1, root: 't', components: {} };

function makeHost(doc: object = DOC) {
	const fake = makeFakePanel();
	const addViewDisposable = { dispose: vi.fn() };
	const addView = vi.fn().mockReturnValue(addViewDisposable);
	const routeInteraction = vi.fn();
	const host = new A2uiPanelHost({
		panel: fake.panel,
		runtimeUri: FAKE_URI,
		surfaceId: 'surf-1',
		doc,
		addView,
		routeInteraction,
	});
	return { host, fake, addView, addViewDisposable, routeInteraction };
}

describe('A2uiPanelHost', () => {
	it('sets strict-CSP HTML with a #root div and the rewritten runtime script', () => {
		const { fake } = makeHost();
		expect(fake.webview.html).toContain('<div id="root"></div>');
		expect(fake.webview.html).toContain(`script-src ${fake.webview.cspSource}`);
		expect(fake.webview.html).toContain(`default-src 'none'`);
		expect(fake.webview.html).toContain('webview:file:///runtime.iife.js');
	});

	it('registers itself as a SurfaceView via addView', () => {
		const { addView, host } = makeHost();
		expect(addView).toHaveBeenCalledWith('surf-1', host);
	});

	it('on READY posts RENDER(doc) to the webview', () => {
		const { fake } = makeHost();
		fake.emit({ type: 'READY', surfaceId: 'surf-1' });
		expect(fake.webview.postMessage).toHaveBeenCalledWith({ type: 'RENDER', doc: DOC });
	});

	it('on INTERACTION calls routeInteraction with the mapped fields', () => {
		const { fake, routeInteraction } = makeHost();
		fake.emit({ type: 'INTERACTION', componentId: 'btn', binding: 'mcp', action: 'refresh', payload: { x: 1 } });
		expect(routeInteraction).toHaveBeenCalledWith('surf-1', 'btn', 'mcp', { x: 1 }, 'refresh');
	});

	it('ignores RESIZE messages', () => {
		const { fake, routeInteraction } = makeHost();
		fake.emit({ type: 'RESIZE', height: 200 });
		expect(routeInteraction).not.toHaveBeenCalled();
		expect(fake.webview.postMessage).not.toHaveBeenCalled();
	});

	it('post() forwards a host→inset message to the webview (SurfaceView contract)', () => {
		const { host, fake } = makeHost();
		const msg: HostToInsetMessage = { type: 'STATE_DELTA', surfaceId: 'surf-1', patch: [{ op: 'add', path: '/x', value: 1 }] };
		host.post(msg);
		expect(fake.webview.postMessage).toHaveBeenCalledWith(msg);
	});

	it('render() re-posts RENDER after READY and reveals the panel', () => {
		const { host, fake } = makeHost();
		fake.emit({ type: 'READY' }); // first RENDER
		(fake.webview.postMessage as any).mockClear();
		const newDoc = { surfaceId: 'surf-1', version: 2, root: 't', components: {} };
		host.render(newDoc);
		expect(fake.webview.postMessage).toHaveBeenCalledWith({ type: 'RENDER', doc: newDoc });
		expect(fake.panel.reveal).toHaveBeenCalled();
	});

	it('render() before READY does not post RENDER but still reveals; the new doc renders on READY', () => {
		const { host, fake } = makeHost();
		const newDoc = { surfaceId: 'surf-1', version: 2, root: 't', components: {} };
		host.render(newDoc);
		expect(fake.panel.reveal).toHaveBeenCalled();
		expect(fake.webview.postMessage).not.toHaveBeenCalled();
		fake.emit({ type: 'READY' });
		expect(fake.webview.postMessage).toHaveBeenCalledWith({ type: 'RENDER', doc: newDoc });
	});

	it('onDidDispose removes the view registration', () => {
		const { fake, addViewDisposable } = makeHost();
		fake.fireDispose();
		expect(addViewDisposable.dispose).toHaveBeenCalledOnce();
	});

	it('post() after dispose is a no-op', () => {
		const { host, fake } = makeHost();
		fake.fireDispose();
		(fake.webview.postMessage as any).mockClear();
		host.post({ type: 'STATE_DELTA', surfaceId: 'surf-1', patch: [] });
		expect(fake.webview.postMessage).not.toHaveBeenCalled();
	});
});
