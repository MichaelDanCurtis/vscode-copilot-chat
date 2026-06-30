/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { validateDocument, type HostToInsetMessage, type InsetToHostMessage } from '@copilot/a2ui-runtime';
import { URI as Uri } from '../../../util/vs/base/common/uri';
import { SurfaceManager, type SurfaceView } from './surfaceManager';
import { McpDataPipe } from './mcpDataPipe';
import { AgUiBridge } from './agUiBridge';
import { createAgentRelay } from './agentRelay';
import { IntervalSnapshotSource, type TimerLike } from './dataSources';
import { CHAT_OPEN_COMMAND } from './insetTransport';

/**
 * Cross-module END-TO-END test for the inline-A2UI/MCP pipeline.
 *
 * Wires the REAL collaborators together — SurfaceManager + McpDataPipe +
 * AgUiBridge + createAgentRelay + the REAL `validateDocument` from
 * `@copilot/a2ui-runtime` — with FAKES only at the true boundaries:
 *   - a fake inset transport (records `post`s) standing in for the core webview,
 *   - a fake panel `SurfaceView` (records `post`s) added via `addView`,
 *   - a spy chat-open executor backing the agent relay,
 *   - a synchronous fake timer so the live feed needs NO real timers.
 *
 * It drives the full chain and asserts each hop, exactly as the live GUI would
 * but headlessly. The live webview/model can only be checked by the manual
 * checklist (docs/superpowers/E2E-CHECKLIST.md); everything below the GUI seam
 * is covered here.
 */

// ─── Fakes at the seams ────────────────────────────────────────────────────────

/** Fake inset transport — the core webview boundary. Records every post. */
function makeInsetTransport() {
	const posts: { surfaceId: string; msg: HostToInsetMessage }[] = [];
	return {
		posts,
		transport: { post: (surfaceId: string, msg: HostToInsetMessage) => { posts.push({ surfaceId, msg }); } },
	};
}

/** Fake panel view (an `A2uiPanelHost` stand-in). Records every post. */
function makePanelView(): SurfaceView & { posts: HostToInsetMessage[] } {
	const posts: HostToInsetMessage[] = [];
	return { posts, post: (msg: HostToInsetMessage) => { posts.push(msg); } };
}

/** Synchronous, injectable timer so live-feed ticks are driven by hand. */
function makeManualTimer(): TimerLike & { fire(): void; cleared: boolean } {
	let cb: (() => void) | undefined;
	const timer = {
		cleared: false,
		setInterval(handler: () => void) { cb = handler; return 1; },
		clearInterval() { timer.cleared = true; cb = undefined; },
		fire() { cb?.(); },
	};
	return timer;
}

const FAKE_URI = Uri.file('/fake/runtime.js');

/** Pull only the STATE_DELTA posts to a given recipient. */
const stateDeltas = (msgs: HostToInsetMessage[]) => msgs.filter(m => m.type === 'STATE_DELTA');

/**
 * Wire the whole stack together the way activation does and return the live
 * objects + the recording seams.
 */
function wireStack() {
	const { posts: insetPosts, transport } = makeInsetTransport();
	const chatExecutor = vi.fn().mockResolvedValue(undefined);
	const relay = createAgentRelay(chatExecutor);

	// The live-feed factory: build an IntervalSnapshotSource driven by a manual
	// timer, subscribe it through the REAL McpDataPipe (which diffs snapshots into
	// STATE_DELTAs and emits them through the bridge → channel → manager.post).
	const timer = makeManualTimer();
	let liveSource: IntervalSnapshotSource | undefined;

	// SurfaceManager is the SurfaceChannel the bridge posts through, AND the
	// coordinator that fans posts out to the inset + every view. The bridge needs
	// the manager and the live-feed factory needs the bridge, so the factory reads
	// the bridge through a holder it captures (resolved by the time it runs).
	const bridgeRef: { current?: AgUiBridge } = {};
	const manager = new SurfaceManager({
		insetTransport: transport,
		// Not exercised in this E2E (agent path is used for the interaction hop);
		// a throwing stub guards against accidental mcp routing.
		mcpPipe: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
		enqueueAgentTurn: (surfaceId, interaction) => relay.enqueueAgentTurn(surfaceId, interaction as any),
		resolveRuntimeUri: () => FAKE_URI,
		startLiveFeed: (surfaceId, live) => {
			liveSource = new IntervalSnapshotSource({ stateKey: live.stateKey, timer });
			return new McpDataPipe(bridgeRef.current!).subscribe(surfaceId, liveSource, live.name ?? live.stateKey);
		},
	});
	const bridge = new AgUiBridge(manager);
	bridgeRef.current = bridge;

	// Activation binds the bridge's inbound INTERACTION to manager.routeInteraction.
	bridge.onInteraction(e => { void manager.routeInteraction(e.surfaceId, e.componentId, e.binding, e.payload, e.action); });

	return { manager, bridge, insetPosts, chatExecutor, timer, getLiveSource: () => liveSource };
}

// ─── The cohesive E2E ──────────────────────────────────────────────────────────

describe('A2UI cross-module E2E (render → validate → fan-out → live → interaction → relay)', () => {

	it('drives the full pipeline through the public seams', async () => {
		const { manager, bridge, insetPosts, chatExecutor, timer, getLiveSource } = wireStack();

		// ── Hop 1: validation gate (ties hardening into the E2E) ─────────────────
		const goodDoc = {
			version: 1,
			surfaceId: 'e2e',
			root: 'root',
			components: {
				root: { id: 'root', type: 'card', props: { title: 'Live', children: ['cht'] } },
				cht: { id: 'cht', type: 'chart', props: { kind: 'area', bind: 'series' } },
			},
			live: { stateKey: 'series', source: 'demo' as const },
		};
		expect(validateDocument(goodDoc as any)).toEqual({ ok: true });

		// An over-cap document (a 100x100 grid → 10,001 components) is REJECTED.
		const overCap: any = { version: 1, surfaceId: 'huge', root: 'root', components: {} };
		overCap.components.root = { id: 'root', type: 'card', props: { title: 'X', children: [] } };
		for (let i = 0; i < 100 * 100; i++) {
			const id = `c${i}`;
			overCap.components.root.props.children.push(id);
			overCap.components[id] = { id, type: 'status', props: { state: 'info', label: 'x' } };
		}
		const rejected = validateDocument(overCap);
		expect(rejected.ok).toBe(false);
		expect((rejected as { errors: string[] }).errors.join(' ')).toContain('exceeds max');

		// ── Hop 2: register + addView → a post fans out to inset AND panel ───────
		manager.register('e2e');
		const panel = makePanelView();
		manager.addView('e2e', panel);

		bridge.emitStateDelta('e2e', [{ op: 'add', path: '/series', value: [1, 2, 3] }]);
		// Inset transport saw it…
		expect(stateDeltas(insetPosts.filter(p => p.surfaceId === 'e2e').map(p => p.msg))).toHaveLength(1);
		// …and so did the panel view (multi-view fan-out).
		expect(stateDeltas(panel.posts)).toHaveLength(1);

		// ── Hop 3: live feed via injected synchronous tick (NO real timers) ──────
		manager.maybeStartLiveFeed('e2e', { stateKey: 'series', source: 'demo' });
		const source = getLiveSource();
		expect(source).toBeDefined();

		const insetBeforeTick = stateDeltas(insetPosts.map(p => p.msg)).length;
		const panelBeforeTick = stateDeltas(panel.posts).length;
		source!.tickOnce(); // one synchronous tick → one snapshot → one STATE_DELTA
		expect(stateDeltas(insetPosts.map(p => p.msg)).length).toBe(insetBeforeTick + 1);
		expect(stateDeltas(panel.posts).length).toBe(panelBeforeTick + 1);
		// The delta carries the live series key the chart binds to.
		const lastInset = stateDeltas(insetPosts.map(p => p.msg)).at(-1) as Extract<HostToInsetMessage, { type: 'STATE_DELTA' }>;
		expect(JSON.stringify(lastInset.patch)).toContain('/series');

		// disposeSurface tears the feed down: a subsequent tick produces NO posts.
		manager.disposeSurface('e2e');
		expect(timer.cleared).toBe(true);
		const insetAfterDispose = insetPosts.length;
		const panelAfterDispose = panel.posts.length;
		source!.tickOnce(); // source disposed → handler detached → nothing emitted
		expect(insetPosts.length).toBe(insetAfterDispose);
		expect(panel.posts.length).toBe(panelAfterDispose);

		// ── Hop 4: agent interaction → relay chat-open + optimistic echo fan-out ─
		// Fresh surface (the previous one was disposed). Re-add the panel view.
		manager.register('seatmap');
		const panel2 = makePanelView();
		manager.addView('seatmap', panel2);

		const interaction: Extract<InsetToHostMessage, { type: 'INTERACTION' }> = {
			type: 'INTERACTION',
			surfaceId: 'seatmap',
			componentId: 'r0c1',
			binding: 'agent',
			action: 'pick-seat',
			payload: { cellId: 'r0c1' },
		};
		// Deliver it the way the core webview would: through the bridge inbound seam.
		bridge.handleInsetMessage(interaction);
		// routeInteraction is async (it awaits the dispatch before the echo) — flush.
		await Promise.resolve();
		await Promise.resolve();

		// Relay set (not submitted) the chat input via workbench.action.chat.open.
		expect(chatExecutor).toHaveBeenCalledTimes(1);
		const [command, args] = chatExecutor.mock.calls[0];
		expect(command).toBe(CHAT_OPEN_COMMAND);
		expect((args as { isPartialQuery: boolean }).isPartialQuery).toBe(true);
		const query = (args as { query: string }).query;
		expect(query).toContain('seatmap');
		expect(query).toContain('r0c1'); // the cellId made it into the chat draft

		// Optimistic-echo STATE_DELTA (clicks/lastAction) fanned to inset AND panel.
		const echoInset = stateDeltas(insetPosts.filter(p => p.surfaceId === 'seatmap').map(p => p.msg));
		expect(echoInset).toHaveLength(1);
		expect(JSON.stringify(echoInset[0].patch)).toContain('/clicks');
		expect(JSON.stringify(echoInset[0].patch)).toContain('/lastAction');
		const echoPanel = stateDeltas(panel2.posts);
		expect(echoPanel).toHaveLength(1);
		expect(echoPanel[0]).toEqual(echoInset[0]); // panel and inset stay identical
	});
});
