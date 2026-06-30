/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpDataPipe, type SnapshotSource } from './mcpDataPipe';
import { AgUiBridge, type SurfaceChannel } from './agUiBridge';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeChannel(): { channel: SurfaceChannel; posts: Array<[string, HostToInsetMessage]> } {
	const posts: Array<[string, HostToInsetMessage]> = [];
	const channel: SurfaceChannel = { post: (surfaceId, msg) => { posts.push([surfaceId, msg]); } };
	return { channel, posts };
}

/**
 * Minimal controllable SnapshotSource for tests.
 * Callers push snapshots via `emit(snapshot)`.
 */
function makeFakeSource(): { source: SnapshotSource; emit: (snapshot: unknown) => void; isDisposed: () => boolean } {
	let cb: ((snapshot: unknown) => void) | undefined;
	let disposed = false;
	const source: SnapshotSource = {
		onSnapshot(handler) {
			cb = handler;
		},
		dispose() {
			disposed = true;
		},
	};
	return {
		source,
		emit: (snapshot: unknown) => { cb?.(snapshot); },
		isDisposed: () => disposed,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpDataPipe', () => {
	let channel: SurfaceChannel;
	let bridge: AgUiBridge;
	let pipe: McpDataPipe;

	beforeEach(() => {
		const fc = makeFakeChannel();
		channel = fc.channel;
		bridge = new AgUiBridge(channel);
		pipe = new McpDataPipe(bridge);
	});

	describe('subscribe — snapshot diffing → STATE_DELTA', () => {
		it('first snapshot (no previous) emits a patch from {} → snapshot1', () => {
			const { source, emit } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			pipe.subscribe('surf-1', source, 'myTool');
			emit({ count: 1 });

			// patch should move from empty baseline {} to {count:1}
			expect(emitSpy).toHaveBeenCalledOnce();
			const [sid, patch] = emitSpy.mock.calls[0];
			expect(sid).toBe('surf-1');
			// fast-json-patch compare({}, {count:1}) → [{ op:'add', path:'/count', value:1 }]
			expect(patch).toContainEqual({ op: 'add', path: '/count', value: 1 });
		});

		it('second snapshot emits a patch from snapshot1 → snapshot2', () => {
			const { source, emit } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			pipe.subscribe('surf-1', source, 'myTool');
			emit({ count: 1 });
			emit({ count: 2 });

			expect(emitSpy).toHaveBeenCalledTimes(2);
			const [sid2, patch2] = emitSpy.mock.calls[1];
			expect(sid2).toBe('surf-1');
			// fast-json-patch compare({count:1},{count:2}) → [{ op:'replace', path:'/count', value:2 }]
			expect(patch2).toContainEqual({ op: 'replace', path: '/count', value: 2 });
		});

		it('does NOT call emitStateDelta when patch is empty (snapshot unchanged)', () => {
			const { source, emit } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			pipe.subscribe('surf-1', source, 'myTool');
			emit({ count: 1 });
			emit({ count: 1 }); // identical — no diff

			// Only the first emit should have triggered (from {} → {count:1})
			expect(emitSpy).toHaveBeenCalledOnce();
		});

		it('after dispose(), further snapshots do NOT call emitStateDelta', () => {
			const { source, emit, isDisposed } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			const disposable = pipe.subscribe('surf-1', source, 'myTool');
			emit({ count: 1 }); // triggers once

			disposable.dispose();
			expect(isDisposed()).toBe(true); // underlying source was torn down

			emit({ count: 2 }); // should be ignored
			expect(emitSpy).toHaveBeenCalledOnce(); // still only 1
		});

		it('malformed snapshot (non-object) does not throw and is dropped', () => {
			const { source, emit } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			pipe.subscribe('surf-1', source, 'myTool');
			// null, string, number, undefined are all invalid JSON-object snapshots
			expect(() => emit(null)).not.toThrow();
			expect(() => emit('bad')).not.toThrow();
			expect(() => emit(42)).not.toThrow();
			expect(() => emit(undefined)).not.toThrow();

			// None of the malformed snapshots should have triggered an emission
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('malformed snapshot does not corrupt state — subsequent valid snapshot still works', () => {
			const { source, emit } = makeFakeSource();
			const emitSpy = vi.spyOn(bridge, 'emitStateDelta');

			pipe.subscribe('surf-1', source, 'myTool');
			emit(null); // bad — dropped
			emit({ count: 5 }); // valid — should diff from {} baseline

			expect(emitSpy).toHaveBeenCalledOnce();
			const [, patch] = emitSpy.mock.calls[0];
			expect(patch).toContainEqual({ op: 'add', path: '/count', value: 5 });
		});
	});

	describe('callTool', () => {
		it('delegates to client.callTool with name and args', async () => {
			const fakeResult = { content: [{ type: 'text', text: 'ok' }] };
			const mockClient = {
				callTool: vi.fn().mockResolvedValue(fakeResult),
			};

			const result = await pipe.callTool(mockClient as any, 'myTool', { x: 1 });

			expect(mockClient.callTool).toHaveBeenCalledOnce();
			expect(mockClient.callTool).toHaveBeenCalledWith({ name: 'myTool', arguments: { x: 1 } });
			expect(result).toBe(fakeResult);
		});
	});
});
