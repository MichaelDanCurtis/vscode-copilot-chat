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

function makeManager(opts: { startLiveFeed?: ReturnType<typeof vi.fn> } = {}) {
	const { post, transport } = makeInsetTransport();
	const { callTool, pipe } = makeMcpPipe();
	const enqueueAgentTurn = vi.fn();
	const resolveRuntimeUri = vi.fn().mockReturnValue(FAKE_URI);

	const manager = new SurfaceManager({
		insetTransport: transport,
		mcpPipe: pipe,
		enqueueAgentTurn,
		resolveRuntimeUri,
		startLiveFeed: opts.startLiveFeed,
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

	describe('stashPendingEmit + drainPendingEmit/drainPendingEmits (EMIT BRIDGE)', () => {
		const rec = (surfaceId: string) => ({ surfaceId, runtimeUri: FAKE_URI, doc: { surfaceId }, version: 1 });

		// --- targeted drain (drainPendingEmit) ---

		it('targeted drain returns undefined when nothing was stashed', () => {
			const { manager } = makeManager();
			expect(manager.drainPendingEmit('x')).toBeUndefined();
		});

		it('targeted drain returns and removes only the requested surfaceId', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.stashPendingEmit(rec('b'));
			expect(manager.drainPendingEmit('a')).toEqual(rec('a'));
			// 'b' must still be present
			expect(manager.drainPendingEmit('b')).toEqual(rec('b'));
			// both now consumed
			expect(manager.drainPendingEmit('a')).toBeUndefined();
			expect(manager.drainPendingEmit('b')).toBeUndefined();
		});

		it('targeted drain for an absent surfaceId does not disturb other entries', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			expect(manager.drainPendingEmit('missing')).toBeUndefined();
			// 'a' still intact
			expect(manager.drainPendingEmit('a')).toEqual(rec('a'));
		});

		it('records carry runtimeUri/doc/version through unchanged', () => {
			const { manager } = makeManager();
			const r = rec('surf-1');
			manager.stashPendingEmit(r);
			expect(manager.drainPendingEmit('surf-1')).toEqual(r);
		});

		it('a fresh stash after targeted drain is independently drainable', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.drainPendingEmit('a');
			manager.stashPendingEmit(rec('c'));
			expect(manager.drainPendingEmit('c')).toEqual(rec('c'));
		});

		// --- batch drain (drainPendingEmits) — retained for backward compatibility ---

		it('batch drain returns nothing when nothing was stashed', () => {
			const { manager } = makeManager();
			expect(manager.drainPendingEmits()).toEqual([]);
		});

		it('batch drain returns all stashed records, then clears them', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.stashPendingEmit(rec('b'));
			const drained = manager.drainPendingEmits();
			expect(drained.map(r => r.surfaceId).sort()).toEqual(['a', 'b']);
			// Second drain (no intervening stash) is empty.
			expect(manager.drainPendingEmits()).toEqual([]);
		});

		it('a fresh stash after batch drain is independently drainable', () => {
			const { manager } = makeManager();
			manager.stashPendingEmit(rec('a'));
			manager.drainPendingEmits();
			manager.stashPendingEmit(rec('c'));
			expect(manager.drainPendingEmits().map(r => r.surfaceId)).toEqual(['c']);
		});

		// --- cross-surface isolation ---

		it('stashing same surfaceId twice overwrites (idempotent, no duplicate emit)', () => {
			const { manager } = makeManager();
			const r1 = { surfaceId: 's', runtimeUri: FAKE_URI, doc: { v: 1 }, version: 1 };
			const r2 = { surfaceId: 's', runtimeUri: FAKE_URI, doc: { v: 2 }, version: 2 };
			manager.stashPendingEmit(r1);
			manager.stashPendingEmit(r2);
			// Only the latest record survives
			expect(manager.drainPendingEmit('s')).toEqual(r2);
			expect(manager.drainPendingEmit('s')).toBeUndefined();
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

	describe('maybeStartLiveFeed (Part C — live feed lifecycle)', () => {
		const live = { stateKey: 'series', source: 'demo' as const, intervalMs: 1000 };

		it('starts a feed and binds its Disposable when the doc declares a live binding', () => {
			const { dispose, disposable } = makeDisposable();
			const startLiveFeed = vi.fn().mockReturnValue(disposable);
			const { manager } = makeManager({ startLiveFeed });

			manager.register('surf-1');
			manager.maybeStartLiveFeed('surf-1', live);

			expect(startLiveFeed).toHaveBeenCalledWith('surf-1', live);
			// The returned Disposable must be torn down on disposeSurface.
			manager.disposeSurface('surf-1');
			expect(dispose).toHaveBeenCalledOnce();
		});

		it('does nothing when no live binding is present', () => {
			const startLiveFeed = vi.fn();
			const { manager } = makeManager({ startLiveFeed });
			manager.register('surf-1');
			manager.maybeStartLiveFeed('surf-1', undefined);
			expect(startLiveFeed).not.toHaveBeenCalled();
		});

		it('does nothing for an unknown/disposed surface', () => {
			const startLiveFeed = vi.fn();
			const { manager } = makeManager({ startLiveFeed });
			manager.maybeStartLiveFeed('never-registered', live);
			expect(startLiveFeed).not.toHaveBeenCalled();
		});

		it('is a no-op when no startLiveFeed factory is wired', () => {
			const { manager } = makeManager();
			manager.register('surf-1');
			expect(() => manager.maybeStartLiveFeed('surf-1', live)).not.toThrow();
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

	describe('routeInteraction — optimistic visible echo (Part C.3 seam)', () => {
		/** Pull the STATE_DELTA echo posts out of a recording transport spy. */
		const echoes = (post: ReturnType<typeof vi.fn>) =>
			post.mock.calls.filter(([, msg]) => (msg as HostToInsetMessage).type === 'STATE_DELTA');

		it('posts a STATE_DELTA echo after routing (clicks + lastAction)', async () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			await manager.routeInteraction('surf-1', 'btn', 'mcp', {}, 'refresh');
			const e = echoes(post);
			expect(e).toHaveLength(1);
			const [surfaceId, msg] = e[0];
			expect(surfaceId).toBe('surf-1');
			expect(msg).toEqual({
				type: 'STATE_DELTA',
				surfaceId: 'surf-1',
				patch: [
					{ op: 'add', path: '/clicks', value: 1 },
					{ op: 'add', path: '/lastAction', value: 'refresh' },
				],
			});
		});

		it('increments the click counter across repeated interactions', async () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			await manager.routeInteraction('surf-1', 'btn', 'mcp', {}, 'a');
			await manager.routeInteraction('surf-1', 'btn', 'agent', {}, 'b');
			const clickValues = echoes(post).map(([, msg]) => (msg as { patch: { value: unknown }[] }).patch[0].value);
			expect(clickValues).toEqual([1, 2]);
		});

		it('falls back to componentId for lastAction when no action is supplied', async () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			await manager.routeInteraction('surf-1', 'submitBtn', 'mcp', {});
			const [, msg] = echoes(post)[0];
			expect((msg as { patch: { value: unknown }[] }).patch[1].value).toBe('submitBtn');
		});

		it('does NOT echo for an unknown/disposed surface', async () => {
			const { manager, post } = makeManager();
			manager.register('surf-1');
			manager.disposeSurface('surf-1');
			await manager.routeInteraction('surf-1', 'btn', 'mcp', {}, 'x');
			expect(echoes(post)).toHaveLength(0);
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
