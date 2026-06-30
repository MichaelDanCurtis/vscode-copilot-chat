/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HostToInsetMessage } from '@copilot/a2ui-runtime';

/**
 * The internal core command that forwards a HostToInsetMessage to the inset
 * webview registered under a given surfaceId. Registered in core
 * (`chatGenerativeUIInsetRegistry.ts`). The underscore marks it as internal
 * (not surfaced in the command palette).
 */
export const POST_TO_SURFACE_COMMAND = '_a2ui.postToSurface';

/**
 * The internal core command the extension REGISTERS so that core can forward
 * inset interactions back to the extension. Core (`chatGenerativeUIInsetPart.ts`)
 * hardcodes this same string (it must not import this package); the extension is
 * the one place that owns the constant. Invoked by core as
 * `executeCommand(ROUTE_INTERACTION_COMMAND, surfaceId, interactionMessage)`.
 * The underscore marks it internal (not surfaced in the command palette).
 */
export const ROUTE_INTERACTION_COMMAND = '_a2ui.routeInteraction';

/**
 * Built-in VS Code command that focuses the Chat view and SETS its input box.
 * Invoked with `{ query, isPartialQuery: true }` it pre-fills the chat input
 * WITHOUT submitting, so a surface interaction (e.g. a seat click) becomes a
 * non-spammy draft the user sends when ready. The agent reverse-channel
 * (`createAgentRelay`) uses exactly this — never the auto-submitting variant.
 */
export const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/**
 * Minimal executor surface. The caller (activate(), in a `vscode-node` module
 * that may import the live `vscode` namespace) passes
 * `vscode.commands.executeCommand`; tests pass a spy. Kept injectable so this
 * `node`-layer module never imports the `vscode` runtime (lint:
 * `local/no-runtime-import`) and stays unit-testable without mocking it.
 */
export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

/**
 * Build the live inset transport that SurfaceManager pushes through.
 *
 * This is the cross-fork channel: `post(surfaceId, msg)` invokes the internal
 * core command `_a2ui.postToSurface`, which looks up the already-rendered inset
 * by surfaceId and forwards `msg` to its webview. A dumb pipe — no A2UI logic.
 *
 * @param executor Command executor (`vscode.commands.executeCommand`).
 */
export function createInsetTransport(
	executor: CommandExecutor,
): { post(surfaceId: string, msg: HostToInsetMessage): void } {
	return {
		post(surfaceId: string, msg: HostToInsetMessage): void {
			executor(POST_TO_SURFACE_COMMAND, surfaceId, msg);
		},
	};
}
