/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import { resolve } from '../../../util/vs/base/common/path';
import { setA2uiEmitDrain, setA2uiSurfaceRegistrar } from '../../a2ui/node/a2uiEmitBridge';
import { AgUiBridge } from '../../a2ui/node/agUiBridge';
import { createInsetTransport, ROUTE_INTERACTION_COMMAND } from '../../a2ui/node/insetTransport';
import { McpDataPipe } from '../../a2ui/node/mcpDataPipe';
import { SurfaceManager } from '../../a2ui/node/surfaceManager';
import { createLiveSource } from '../../a2ui/node/dataSources';
import { baseActivate } from '../vscode/extension';
import { vscodeNodeContributions } from './contributions';
import { registerServices } from './services';

// ###############################################################################################
// ###                                                                                         ###
// ###                 Node extension that runs ONLY in node.js extension host.                ###
// ###                                                                                         ###
// ### !!! Prefer to add code in ../vscode/extension.ts to support all extension runtimes !!!  ###
// ###                                                                                         ###
// ###############################################################################################

//#region TODO@bpasero this needs cleanup
import '../../intents/node/allIntents';

function configureDevPackages() {
	try {
		const sourceMapSupport = require('source-map-support');
		sourceMapSupport.install();
		const dotenv = require('dotenv');
		dotenv.config({ path: [resolve(__dirname, '../.env')] });
	} catch (err) {
		console.error(err);
	}
}
//#endregion

export function activate(context: ExtensionContext, forceActivation?: boolean) {
	registerA2ui(context);
	return baseActivate({
		context,
		registerServices,
		contributions: vscodeNodeContributions,
		configureDevPackages,
		forceActivation
	});
}

/**
 * Wire the A2UI inline generative-UI feature (STATIC render scope).
 *
 * Resolves the bundled `@copilot/a2ui-runtime` IIFE asset, constructs the
 * {@link SurfaceManager} that owns surface lifecycle, and registers the
 * `render_a2ui` Language-Model Tool.
 *
 * Phase-5.1 (LIVE STATE_DELTA TRANSPORT): `insetTransport.post` is now the
 * real cross-fork channel — it invokes the internal core command
 * `_a2ui.postToSurface`, which forwards the message to the already-rendered
 * inset registered under that surfaceId. The live data path is also wired:
 * `McpDataPipe(bridge)` diffs MCP snapshots into STATE_DELTA patches, the
 * `AgUiBridge` (using the SurfaceManager as its SurfaceChannel) turns those into
 * HostToInsetMessages, and `surfaceManager.post` pushes them through the command
 * to the inset. So: bridge.emitStateDelta → surfaceManager.post → command → inset.
 *
 * Remaining Phase-5 deferrals (NOT this task):
 *   - `mcpPipe.callTool`  — throws (interaction routing is Task 5.2).
 *   - `enqueueAgentTurn`  — no-op (agent reverse-channel is Task 5.2).
 *   - An actual MCP server subscription (`mcpDataPipe.subscribe(...)`) is a
 *     config/runtime concern; the objects are wired so the path is complete,
 *     but no live subscription is created here.
 *
 * KNOWN GAP (see wiring-report Part B): a tool registered via
 * `vscode.lm.registerTool` cannot access a `ChatResponseStream`, so the tool's
 * `invoke()` reserves the surface but cannot itself emit the in-bubble inset.
 * The `stream.generativeUI(...)` emit must be performed by the chat-participant
 * handler that owns the stream (via {@link RenderA2uiTool.invokeWith}).
 */
function registerA2ui(context: ExtensionContext): void {
	// LIVE DATA PATH: the bridge + MCP pipe carry deltas end-to-end. The bridge's
	// SurfaceChannel is the SurfaceManager itself (set below), so
	// bridge.emitStateDelta → surfaceManager.post → insetTransport → command →
	// inset. McpDataPipe(bridge) diffs each SnapshotSource snapshot into those
	// STATE_DELTA emits. We construct the bridge against a late-bound channel so
	// the pipe can be created before the manager (the manager needs the pipe for
	// startLiveFeed). The channel forwards to the manager once it exists; a holder
	// object breaks the construction cycle without a reassigned binding.
	// Diagnostics channel for the A2UI feature (e.g. live-feed source selection).
	// This bootstrap activate() has no DI accessor in scope, so an output channel
	// is the idiomatic sink here rather than console.* (per repo logging rules).
	const a2uiLog = vscode.window.createOutputChannel('A2UI');
	context.subscriptions.push(a2uiLog);

	const channelHolder: { manager: SurfaceManager | undefined } = { manager: undefined };
	const agUiBridge = new AgUiBridge({ post: (surfaceId, msg) => channelHolder.manager?.post(surfaceId, msg) });
	const mcpDataPipe = new McpDataPipe(agUiBridge);

	const surfaceManager = new SurfaceManager({
		resolveRuntimeUri: () => vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@copilot', 'a2ui-runtime', 'dist', 'runtime.iife.js'),
		// LIVE host→inset push: forward through the internal core command which
		// looks the inset up by surfaceId and posts to its webview.
		insetTransport: createInsetTransport((command, ...args) => vscode.commands.executeCommand(command, ...args)),
		// Phase-3 wiring stubs (interaction reverse-channel). These are the seams
		// Phase 3 (live MCP) replaces with real dispatch; for now they are benign
		// no-ops so the OPTIMISTIC state echo in routeInteraction always fires and
		// the round-trip is visible. (A throwing callTool would abort before the echo.)
		mcpPipe: { callTool: async () => ({ content: [] }) /* TODO(phase3): real MCP tool call */ },
		enqueueAgentTurn: () => { /* TODO(phase3): agent reverse-channel for interactions */ },
		// LIVE FEED: when a rendered doc declares a `live` binding, build the
		// matching SnapshotSource (demo → IntervalSnapshotSource; mcp →
		// McpResourceSnapshotSource when a client is wired, else demo fallback),
		// subscribe it through the pipe, and return the subscription Disposable so
		// disposeSurface tears the feed down. No MCP client is wired in this phase,
		// so `source:'mcp'` logs a note and falls back to the demo feed.
		startLiveFeed: (surfaceId, live) => {
			const source = createLiveSource(
				live,
				undefined /* TODO(phase3): resolve a concrete McpClientLike */,
				message => a2uiLog.appendLine(message),
			);
			return mcpDataPipe.subscribe(surfaceId, source, live.name ?? live.stateKey);
		},
	});
	channelHolder.manager = surfaceManager;

	// The `render_a2ui` tool is registered through the internal `ToolRegistry`
	// (see a2ui/node/renderA2uiTool.ts), imported by the tool barrel
	// (tools/node/allTools.ts) and DI-instantiated + `vscode.lm.registerTool`'d by
	// `ToolsContribution`. That registry is the path the agent builds its toolset
	// from, so the tool is now visible to the model. Because DI-instantiated ctors
	// cannot receive this activate()-constructed SurfaceManager, publish it through
	// the shared module-level holder for the tool to resolve in `invoke()`.
	setA2uiSurfaceRegistrar(surfaceManager);
	context.subscriptions.push({ dispose: () => setA2uiSurfaceRegistrar(undefined) });

	// EMIT BRIDGE ("Option A"): publish the SAME SurfaceManager instance so the
	// stream-owning tool-calling handler (buildToolResultElement in
	// prompts/node/panel/toolCalling.tsx) can drain surfaces reserved by the
	// stream-less tool path and emit them via stream.generativeUI(...).
	setA2uiEmitDrain(surfaceManager);
	context.subscriptions.push({ dispose: () => setA2uiEmitDrain(undefined) });

	// INTERACTION REVERSE-CHANNEL: register the core-invoked routing command.
	// Core (`chatGenerativeUIInsetPart.ts`) forwards each inset INTERACTION by
	// executing `_a2ui.routeInteraction` with (surfaceId, interactionMessage). We
	// route it to the SurfaceManager, which dispatches (mcp/agent) and posts the
	// optimistic STATE_DELTA echo back to the inset — closing the round-trip.
	context.subscriptions.push(
		vscode.commands.registerCommand(
			ROUTE_INTERACTION_COMMAND,
			(surfaceId: string, msg: { componentId: string; binding: 'mcp' | 'agent'; action?: string; payload: unknown }) =>
				surfaceManager.routeInteraction(surfaceId, msg.componentId, msg.binding, msg.payload, msg.action),
		),
	);
}
