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
