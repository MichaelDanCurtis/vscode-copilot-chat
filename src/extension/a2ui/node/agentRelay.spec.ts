/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { createAgentRelay } from './agentRelay';
import { CHAT_OPEN_COMMAND } from './insetTransport';

describe('agentRelay', () => {
	it('a cellId interaction sets the chat input to a summary (surfaceId + cellId, isPartialQuery)', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-1', { componentId: 'r0c0', action: 'pick-seat', payload: { cellId: 'r0c0' } });

		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor).toHaveBeenCalledWith(CHAT_OPEN_COMMAND, { query: expect.any(String), isPartialQuery: true });
		const query = (executor.mock.calls[0][1] as { query: string }).query;
		expect(query).toContain('surf-1');
		expect(query).toContain('r0c0');
	});

	it('accumulates a second cellId on the same surface (both appear)', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-1', { componentId: 'r0c0', action: 'pick-seat', payload: { cellId: 'r0c0' } });
		relay.enqueueAgentTurn('surf-1', { componentId: 'r1c2', action: 'pick-seat', payload: { cellId: 'r1c2' } });

		expect(executor).toHaveBeenCalledTimes(2);
		const query = (executor.mock.calls[1][1] as { query: string }).query;
		expect(query).toContain('r0c0');
		expect(query).toContain('r1c2');
		expect((executor.mock.calls[1][1] as { isPartialQuery: boolean }).isPartialQuery).toBe(true);
	});

	it('de-dupes repeat clicks on the same cell', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-1', { componentId: 'r0c0', payload: { cellId: 'r0c0' } });
		relay.enqueueAgentTurn('surf-1', { componentId: 'r0c0', payload: { cellId: 'r0c0' } });

		const query = (executor.mock.calls[1][1] as { query: string }).query;
		// "r0c0" appears exactly once in the cumulative list.
		expect(query.match(/r0c0/g)?.length).toBe(1);
	});

	it('keeps accumulation separate per surfaceId', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-1', { componentId: 'r0c0', payload: { cellId: 'r0c0' } });
		relay.enqueueAgentTurn('surf-2', { componentId: 'r1c1', payload: { cellId: 'r1c1' } });

		const q2 = (executor.mock.calls[1][1] as { query: string }).query;
		expect(q2).toContain('surf-2');
		expect(q2).toContain('r1c1');
		expect(q2).not.toContain('r0c0');
	});

	it('formats a generic (non-cellId) payload generically', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-9', { componentId: 'submit-btn', action: 'submit', payload: { name: 'Ada', tier: 'gold' } });

		expect(executor).toHaveBeenCalledTimes(1);
		const query = (executor.mock.calls[0][1] as { query: string }).query;
		expect(query).toContain('submit on surf-9');
		expect(query).toContain('"name":"Ada"');
		expect(query).toContain('"tier":"gold"');
	});

	it('falls back to componentId when no action is present for a generic payload', () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const relay = createAgentRelay(executor);

		relay.enqueueAgentTurn('surf-9', { componentId: 'toggle-x', payload: { on: true } });

		const query = (executor.mock.calls[0][1] as { query: string }).query;
		expect(query).toContain('toggle-x on surf-9');
		expect(query).toContain('"on":true');
	});
});
