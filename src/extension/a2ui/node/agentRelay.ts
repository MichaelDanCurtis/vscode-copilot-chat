/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CHAT_OPEN_COMMAND, type CommandExecutor } from './insetTransport';

/**
 * A single surface interaction routed to the agent reverse-channel. Mirrors the
 * `{ componentId, payload, action }` shape the SurfaceManager forwards for a
 * `binding:'agent'` interaction.
 */
export interface AgentInteraction {
	readonly componentId: string;
	readonly payload: unknown;
	readonly action?: string;
}

/** The agent reverse-channel surfaced to the SurfaceManager. */
export interface AgentRelay {
	/**
	 * Reflect a surface interaction into the chat input. Sets (does NOT submit)
	 * the Chat view's input box to a readable summary of the interaction(s) so
	 * far for the surface, leaving the user to send when ready.
	 */
	enqueueAgentTurn(surfaceId: string, interaction: AgentInteraction): void;
}

/**
 * Extract a grid cell id from an interaction payload, or `undefined` when the
 * payload is not a `{ cellId }` selection.
 */
function cellIdOf(payload: unknown): string | undefined {
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		const value = (payload as Record<string, unknown>).cellId;
		if (typeof value === 'string') {
			return value;
		}
	}
	return undefined;
}

/**
 * Build the agent reverse-channel that turns surface interactions into a chat
 * input draft.
 *
 * MECHANISM: each interaction invokes `workbench.action.chat.open` with
 * `{ query, isPartialQuery: true }`, which focuses the Chat view and SETS its
 * input box without submitting. The user reviews and sends. (No auto-submit —
 * that would be spammy on every click.)
 *
 * ACCUMULATION: grid selections (`payload.cellId`) accumulate PER surfaceId in a
 * `Map<surfaceId, Set<cellId>>`, so clicking several seats builds a cumulative
 * summary — e.g. `Selected seats on <surfaceId>: r0c0, r1c2`. The set preserves
 * insertion order and de-dupes repeat clicks. Non-cellId payloads do not
 * accumulate; they format generically as
 * `<action> on <surfaceId>: <compact JSON of payload>`.
 *
 * The executor is injected (`vscode.commands.executeCommand` at activation, a
 * spy in tests) so this node-layer module never imports the `vscode` runtime.
 *
 * @param executor Command executor (`vscode.commands.executeCommand`).
 */
/**
 * Cap on the per-surface accumulated selection Set. The cellIds come from a
 * model-authored document, so the set is bounded to prevent unbounded growth of
 * both the in-memory map and the prefilled chat-input summary. Additions beyond
 * the cap are ignored (the existing selections are kept).
 */
const MAX_SELECTIONS_PER_SURFACE = 200;

/**
 * Neutralize a composed chat-input query so it can never be interpreted as a
 * slash-command or agent-mention. The query is built from model-authored
 * surfaceId/payload, so a leading `/` or `@` (after trimming) is prefixed with a
 * space to keep it plain text the user must read before sending.
 */
function neutralizeChatQuery(query: string): string {
	const trimmedStart = query.replace(/^\s+/, '');
	if (trimmedStart.startsWith('/') || trimmedStart.startsWith('@')) {
		return ` ${query}`;
	}
	return query;
}

export function createAgentRelay(executor: CommandExecutor): AgentRelay {
	// Accumulated grid cell selections per surfaceId. Insertion-ordered, de-duped.
	const selections = new Map<string, Set<string>>();

	return {
		enqueueAgentTurn(surfaceId: string, interaction: AgentInteraction): void {
			const cellId = cellIdOf(interaction.payload);
			let summary: string;
			if (cellId !== undefined) {
				let set = selections.get(surfaceId);
				if (!set) {
					set = new Set<string>();
					selections.set(surfaceId, set);
				}
				// Bound the set: ignore further additions once at the cap (unless the
				// cellId is already present, which is a no-op de-dupe).
				if (set.has(cellId) || set.size < MAX_SELECTIONS_PER_SURFACE) {
					set.add(cellId);
				}
				summary = `Selected seats on ${surfaceId}: ${[...set].join(', ')}`;
			} else {
				const action = interaction.action ?? interaction.componentId;
				summary = `${action} on ${surfaceId}: ${JSON.stringify(interaction.payload)}`;
			}
			executor(CHAT_OPEN_COMMAND, { query: neutralizeChatQuery(summary), isPartialQuery: true });
		},
	};
}
