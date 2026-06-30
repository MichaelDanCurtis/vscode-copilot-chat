/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { SurfaceManager } from './surfaceManager';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import { URI as Uri } from '../../../util/vs/base/common/uri';

// ---------------------------------------------------------------------------
// Test doubles / helpers
// ---------------------------------------------------------------------------

function makeInsetTransport(): { post: ReturnType<typeof vi.fn>; transport: { post(surfaceId: string, msg: HostToInsetMessage): void } } {
	const post = vi.fn();
	return { post, transport: { post } };
}

function makeMcpPipe(): { callTool: ReturnType<typeof vi.fn>; pipe: { callTool(client: unknown, name: string, args: Record<string, unknown>): Promise<unknown> } } {
	const callTool = vi.fn().mockResolvedValue({ content: [] });
	return { callTool, pipe: { callTool } };
}

function makeDisposable(): { dispose: ReturnType<typeof vi.fn>; disposable: { dispose(): void } } {
	const dispose = vi.fn();
	return { dispose, disposable: { dispose } };
}

const FAKE_URI = Uri.file('/fake/runtime.js');

function makeManager() {
	const { post, transport } = makeInsetTransport();
	const { callTool, pipe } = makeMcpPipe();
	const enqueueAgentTurn = vi.fn();
	const resolveRuntimeUri = vi.fn().mockReturnValue(FAKE_URI);

	const manager = new SurfaceManager({
		insetTransport: transport,
		mcpPipe: pipe,
		enqueueAgentTurn,
		resolveRuntimeUri,
	});

	return { manager, post, callTool, enqueueAgentTurn, resolveRuntimeUri };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SurfaceManager', () => {

	describe('register', () => {
		it('returns runtimeUri from the injected resolver', () => {
			const { manager, resolveRuntimeUri } = makeManager();
			const result = manager.register('surf-1');
			expect(resolveRuntimeUri).toHaveBeenCalledWith('surf-1');
			expect(result.runtimeUri).toBe(FAKE_URI);
		});

		it('creates a surface record (subsequent operations do not throw)', () => {
			const { manager } = makeManager();
			manager.register('surf-1');
			// If no record was created, disposeSurface would be a no-op — but at minimum calling it must not throw
			expect(() => manager.disposeSurface('surf-1')).not.toThrow();
		});

		it('registers multiple surfaces independently', () => {
			const { manager, resolveRuntimeUri } = makeManager();
			const r1 = manager.register('surf-1');
			const r2 = manager.register('surf-2');
			expect(resolveRuntimeUri).toHaveBeenCalledTimes(2);
			expect(r1.runtimeUri).toBe(FAKE_URI);
			expect(r2.runtimeUri).toBe(FAKE_URI);
		});

		it('disposes prior MCP subscription on re-register (leak prevention)', () => {
			const { manager } = makeManager();
			const { dispose: dispose1, disposable: disposable1 } = makeDisposable();
			const { dispose: dispose2, disposable: disposable2 } = makeDisposable();
			manager.register('surf-1');
			manager.bindMcp('surf-1', disposable1);
			expect(dispose1).not.toHaveBeenCalled();
			manager.register('surf-1'); // re-register the same surfaceId
			expect(dispose1).toHaveBeenCalledOnce(); // prior subscription must be disposed
			manager.bindMcp('surf-1', disposable2);
			manager.disposeSurface('surf-1');
			expect(dispose2).toHaveBeenCalledOnce();
		});
	});

	describe('stashPendingEmit + drainPendingEmits (EMIT BRIDGE)', () => {
		const rec = (surfaceId: string) => ({ surfaceId, runtimeUri: FAKE_URI, doc: { surfaceId }, version: 1 });

		it('drain returns nothing when nothing was stashed', () => {
			const { manager } = makeManager();
			expect(manager.drainPendingEmits()).toEqual([]);
		});

		it('drain returns stashed records in FIFO order, then clears them', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.stashPendingEmit(rec('b'));
			const drained = manager.drainPendingEmits();
			expect(drained.map(r => r.surfaceId)).toEqual(['a', 'b']);
			// Second drain (no intervening stash) is empty — the queue was cleared.
			expect(manager.drainPendingEmits()).toEqual([]);
		});

		it('records carry runtimeUri/doc/version through unchanged', () => {
			const { manager } = makeManager();
			const r = rec('surf-1');
			manager.stashPendingEmit(r);
			const [drained] = manager.drainPendingEmits();
			expect(drained).toEqual(r);
		});

		it('a fresh stash after drain is independently drainable', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.drainPendingEmits();
			manager.stashPendingEmit(rec('c'));
			expect(manager.drainPendingEmits().map(r => r.surfaceId)).toEqual(['c']);
		});
	});

	describe('post', () => {
		it('delegates to insetTransport.post with the same arguments', () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			const msg: HostToInsetMessage = { type: 'DISPOSE', surfaceId: 'surf-1' };
			manager.post('surf-1', msg);
			expect(post).toHaveBeenCalledOnce();
			expect(post).toHaveBeenCalledWith('surf-1', msg);
		});

		it('forwards STATE_DELTA messages unchanged', () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			const msg: HostToInsetMessage = { type: 'STATE_DELTA', surfaceId: 'surf-1', patch: [{ op: 'add', path: '/x', value: 1 }] };
			manager.post('surf-1', msg);
			expect(post).toHaveBeenCalledWith('surf-1', msg);
		});
	});

	describe('bindMcp + disposeSurface', () => {
		it('disposes the subscription when disposeSurface is called', () => {
			const { manager } = makeManager();
			const { dispose, disposable } = makeDisposable();
			manager.register('surf-1');
			manager.bindMcp('surf-1', disposable);
			manager.disposeSurface('surf-1');
			expect(dispose).toHaveBeenCalledOnce();
		});

		it('is idempotent — calling disposeSurface twice only disposes once', () => {
			const { manager } = makeManager();
			const { dispose, disposable } = makeDisposable();
			manager.register('surf-1');
			manager.bindMcp('surf-1', disposable);
			manager.disposeSurface('surf-1');
			manager.disposeSurface('surf-1'); // second call must be a no-op
			expect(dispose).toHaveBeenCalledOnce();
		});

		it('disposeSurface on unknown surface does not throw', () => {
			const { manager } = makeManager();
			expect(() => manager.disposeSurface('nonexistent')).not.toThrow();
		});

		it('removes the surface record so a third disposeSurface is still safe', () => {
			const { manager } = makeManager();
			const { dispose, disposable } = makeDisposable();
			manager.register('surf-1');
			manager.bindMcp('surf-1', disposable);
			manager.disposeSurface('surf-1');
			manager.disposeSurface('surf-1');
			manager.disposeSurface('surf-1');
			expect(dispose).toHaveBeenCalledOnce();
		});
	});

	describe('routeInteraction', () => {
		it('binding "mcp" calls mcpPipe.callTool', async () => {
			const { manager, callTool } = makeManager();
			manager.register('surf-1');
			const payload = { value: 42 };
			await manager.routeInteraction('surf-1', 'btn', 'mcp', payload);
			expect(callTool).toHaveBeenCalledOnce();
		});

		it('binding "agent" calls enqueueAgentTurn', async () => {
			const { manager, enqueueAgentTurn, callTool } = makeManager();
			manager.register('surf-1');
			const payload = { intent: 'explain' };
			await manager.routeInteraction('surf-1', 'btn', 'agent', payload);
			expect(enqueueAgentTurn).toHaveBeenCalledOnce();
			expect(enqueueAgentTurn).toHaveBeenCalledWith('surf-1', expect.anything());
			expect(callTool).not.toHaveBeenCalled();
		});

		it('binding "mcp" does NOT call enqueueAgentTurn', async () => {
			const { manager, enqueueAgentTurn } = makeManager();
			manager.register('surf-1');
			await manager.routeInteraction('surf-1', 'btn', 'mcp', {});
			expect(enqueueAgentTurn).not.toHaveBeenCalled();
		});
	});

	describe('post after disposeSurface (STATE_DELTA drop decision)', () => {
		/**
		 * BEHAVIOR DECISION: post() after disposeSurface() is a DROP.
		 *
		 * Rationale: once a surface is torn down, its inset is gone. Forwarding
		 * messages to a disposed inset would be a logic error (dangling reference).
		 * Silently dropping is the safest choice — the caller holds a reference to
		 * SurfaceManager but has no way to know the surface was already destroyed.
		 * No throw, no crash, just a no-op. This mirrors how VS Code disposables work.
		 *
		 * To assert the drop we verify insetTransport.post is NOT called after dispose.
		 */
		it('drops the message (does not forward to insetTransport) after disposeSurface', () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			manager.disposeSurface('surf-1');
			const msg: HostToInsetMessage = { type: 'STATE_DELTA', surfaceId: 'surf-1', patch: [] };
			expect(() => manager.post('surf-1', msg)).not.toThrow();
			expect(post).not.toHaveBeenCalled();
		});
	});
});
