/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HostToInsetMessage, InsetToHostMessage } from '@copilot/a2ui-runtime';

/**
 * Narrow interface for posting messages to an inset surface.
 * Task 3.6's SurfaceManager will implement this.
 */
export interface SurfaceChannel {
	post(surfaceId: string, msg: HostToInsetMessage): void;
}

type InteractionMessage = Extract<InsetToHostMessage, { type: 'INTERACTION' }>;
type StateDeltaPatch = Extract<HostToInsetMessage, { type: 'STATE_DELTA' }>['patch'];

/**
 * Thin bridge between the agent data-flow and inset surfaces.
 * Translates STATE_DELTA patches into HostToInsetMessage and dispatches
 * inbound INTERACTION messages to a registered handler. No business logic.
 */
export class AgUiBridge {
	private _interactionHandler: ((e: InteractionMessage) => void) | undefined;

	constructor(private readonly channel: SurfaceChannel) { }

	/** Forward a JSON-Patch array to the named surface as a STATE_DELTA message. */
	emitStateDelta(surfaceId: string, patch: StateDeltaPatch): void {
		this.channel.post(surfaceId, { type: 'STATE_DELTA', surfaceId, patch });
	}

	/** Register the handler that will be called for every inbound INTERACTION event. */
	onInteraction(handler: (e: InteractionMessage) => void): void {
		this._interactionHandler = handler;
	}

	/** Deliver an inbound message from the inset. Only INTERACTION messages are dispatched. */
	handleInsetMessage(msg: InsetToHostMessage): void {
		if (msg.type === 'INTERACTION') {
			this._interactionHandler?.(msg);
		}
	}
}
