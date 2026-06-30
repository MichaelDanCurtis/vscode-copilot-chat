/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import { resolve } from '../../../util/vs/base/common/path';
import { RenderA2uiTool } from '../../a2ui/node/renderA2uiTool';
import { SurfaceManager } from '../../a2ui/node/surfaceManager';
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
 * Phase-5 deferral: the SurfaceManager collaborators below are intentional
 * minimal-safe stubs for the static-render milestone. Live STATE_DELTA push,
 * the interaction reverse-channel, and MCP subscription wiring all flow through
 * these collaborators and will be implemented in Phase 5:
 *   - `insetTransport.post`  — no-op (no live host→inset push yet).
 *   - `mcpPipe.callTool`     — throws (interaction routing not wired yet).
 *   - `enqueueAgentTurn`     — no-op (agent reverse-channel not wired yet).
 *
 * KNOWN GAP (see wiring-report Part B): a tool registered via
 * `vscode.lm.registerTool` cannot access a `ChatResponseStream`, so the tool's
 * `invoke()` reserves the surface but cannot itself emit the in-bubble inset.
 * The `stream.generativeUI(...)` emit must be performed by the chat-participant
 * handler that owns the stream (via {@link RenderA2uiTool.invokeWith}).
 */
function registerA2ui(context: ExtensionContext): void {
	const surfaceManager = new SurfaceManager({
		resolveRuntimeUri: () => vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@copilot', 'a2ui-runtime', 'dist', 'runtime.iife.js'),
		// Phase-5 wiring stubs (static-render scope only) — see function doc.
		insetTransport: { post: () => { /* TODO(phase5): live host→inset STATE_DELTA push */ } },
		mcpPipe: { callTool: async () => { throw new Error('A2UI mcpPipe.callTool not wired yet (Phase 5)'); } },
		enqueueAgentTurn: () => { /* TODO(phase5): agent reverse-channel for interactions */ },
	});

	context.subscriptions.push(vscode.lm.registerTool('render_a2ui', new RenderA2uiTool(surfaceManager)));
}
