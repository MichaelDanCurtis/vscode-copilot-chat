/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { McpDataPipe, type McpClientLike } from './mcpDataPipe';
import { AgUiBridge, type SurfaceChannel } from './agUiBridge';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import {
	IntervalSnapshotSource,
	McpResourceSnapshotSource,
	createLiveSource,
	type TimerLike,
} from './dataSources';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A timer double that never actually schedules — the test drives ticks itself. */
const noopTimer: TimerLike = {
	setInterval: () => 'handle',
	clearInterval: () => { /* noop */ },
};

function makeFakeChannel(): { channel: SurfaceChannel; posts: Array<[string, HostToInsetMessage]> } {
	const posts: Array<[string, HostToInsetMessage]> = [];
	const channel: SurfaceChannel = { post: (surfaceId, msg) => { posts.push([surfaceId, msg]); } };
	return { channel, posts };
}

// ---------------------------------------------------------------------------
// IntervalSnapshotSource
// ---------------------------------------------------------------------------

describe('IntervalSnapshotSource', () => {
	it('emits an evolving series snapshot on each tick', () => {
		const snapshots: unknown[] = [];
		const src = new IntervalSnapshotSource({
			stateKey: 'series',
			windowSize: 3,
			timer: noopTimer,
			next: t => t, // deterministic: 0, 1, 2, 3...
		});
		src.onSnapshot(s => snapshots.push(s));

		src.tickOnce();
		src.tickOnce();
		src.tickOnce();

		expect(snapshots[0]).toEqual({ series: [0] });
		expect(snapshots[1]).toEqual({ series: [0, 1] });
		expect(snapshots[2]).toEqual({ series: [0, 1, 2] });
	});

	it('keeps a rolling window of the configured size', () => {
		const snapshots: Array<{ series: number[] }> = [];
		const src = new IntervalSnapshotSource({
			stateKey: 'series',
			windowSize: 2,
			timer: noopTimer,
			next: t => t,
		});
		src.onSnapshot(s => snapshots.push(s as { series: number[] }));

		src.tickOnce(); // [0]
		src.tickOnce(); // [0,1]
		src.tickOnce(); // [1,2] — oldest shifted out

		expect(snapshots[2]).toEqual({ series: [1, 2] });
	});

	it('starts a timer via the injected TimerLike when a handler attaches', () => {
		const setInterval = vi.fn().mockReturnValue('h');
		const clearInterval = vi.fn();
		const src = new IntervalSnapshotSource({ intervalMs: 500, timer: { setInterval, clearInterval } });

		src.onSnapshot(() => { /* noop */ });
		expect(setInterval).toHaveBeenCalledOnce();
		expect(setInterval.mock.calls[0][1]).toBe(500);

		src.dispose();
		expect(clearInterval).toHaveBeenCalledOnce();
	});

	it('dispose() stops further emissions', () => {
		const snapshots: unknown[] = [];
		const src = new IntervalSnapshotSource({ timer: noopTimer, next: t => t });
		src.onSnapshot(s => snapshots.push(s));

		src.tickOnce();
		src.dispose();
		src.tickOnce(); // ignored

		expect(snapshots).toHaveLength(1);
	});

	it('feeds STATE_DELTA patches through McpDataPipe end-to-end', () => {
		const { channel, posts } = makeFakeChannel();
		const bridge = new AgUiBridge(channel);
		const pipe = new McpDataPipe(bridge);

		const src = new IntervalSnapshotSource({ stateKey: 'series', timer: noopTimer, next: t => t });
		pipe.subscribe('surf-1', src, 'demo');

		src.tickOnce(); // {} -> {series:[0]}
		src.tickOnce(); // {series:[0]} -> {series:[0,1]}

		expect(posts).toHaveLength(2);
		const [, first] = posts[0];
		expect(first).toMatchObject({ type: 'STATE_DELTA', surfaceId: 'surf-1' });
	});
});

// ---------------------------------------------------------------------------
// McpResourceSnapshotSource
// ---------------------------------------------------------------------------

describe('McpResourceSnapshotSource', () => {
	it('polls the named tool and forwards the result as a snapshot', async () => {
		const client: McpClientLike = {
			callTool: vi.fn().mockResolvedValue({ series: [1, 2, 3] }),
		};
		const snapshots: unknown[] = [];
		const src = new McpResourceSnapshotSource({ client, name: 'getMetrics', timer: noopTimer });
		src.onSnapshot(s => snapshots.push(s));

		await src.poll();

		expect(client.callTool).toHaveBeenCalledWith({ name: 'getMetrics', arguments: {} });
		expect(snapshots[0]).toEqual({ series: [1, 2, 3] });
	});

	it('applies the toSnapshot mapper to the raw result', async () => {
		const client: McpClientLike = {
			callTool: vi.fn().mockResolvedValue({ content: [{ value: 7 }, { value: 8 }] }),
		};
		const snapshots: unknown[] = [];
		const src = new McpResourceSnapshotSource({
			client,
			name: 'tool',
			timer: noopTimer,
			toSnapshot: (r: any) => ({ series: r.content.map((c: any) => c.value) }),
		});
		src.onSnapshot(s => snapshots.push(s));

		await src.poll();
		expect(snapshots[0]).toEqual({ series: [7, 8] });
	});

	it('dispose() stops polling and drops in-flight results', async () => {
		let resolveCall: (v: unknown) => void = () => { };
		const client: McpClientLike = {
			callTool: vi.fn().mockImplementation(() => new Promise(res => { resolveCall = res; })),
		};
		const snapshots: unknown[] = [];
		const src = new McpResourceSnapshotSource({ client, name: 'tool', timer: noopTimer });
		src.onSnapshot(s => snapshots.push(s));

		const pollPromise = src.poll();
		src.dispose();
		resolveCall({ series: [9] }); // resolves AFTER dispose
		await pollPromise;

		expect(snapshots).toHaveLength(0);
	});

	it('swallows poll errors without throwing (interval survives)', async () => {
		const client: McpClientLike = {
			callTool: vi.fn().mockRejectedValue(new Error('mcp boom')),
		};
		const src = new McpResourceSnapshotSource({ client, name: 'tool', timer: noopTimer });
		src.onSnapshot(() => { /* noop */ });

		await expect(src.poll()).resolves.toBeUndefined();
	});

	it('starts and clears the timer via TimerLike', () => {
		const setInterval = vi.fn().mockReturnValue('h');
		const clearInterval = vi.fn();
		const client: McpClientLike = { callTool: vi.fn().mockResolvedValue({}) };
		const src = new McpResourceSnapshotSource({ client, name: 'tool', intervalMs: 250, timer: { setInterval, clearInterval } });

		src.onSnapshot(() => { /* noop */ });
		expect(setInterval).toHaveBeenCalledOnce();
		expect(setInterval.mock.calls[0][1]).toBe(250);

		src.dispose();
		expect(clearInterval).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// createLiveSource factory
// ---------------------------------------------------------------------------

describe('createLiveSource', () => {
	it('builds an IntervalSnapshotSource for the demo source', () => {
		const src = createLiveSource({ stateKey: 'series', source: 'demo', intervalMs: 1000 }, undefined);
		expect(src).toBeInstanceOf(IntervalSnapshotSource);
	});

	it('builds an McpResourceSnapshotSource for the mcp source when a client + name exist', () => {
		const client: McpClientLike = { callTool: vi.fn() };
		const src = createLiveSource({ stateKey: 'series', source: 'mcp', name: 'getMetrics' }, client);
		expect(src).toBeInstanceOf(McpResourceSnapshotSource);
	});

	it('falls back to demo (with a logged note) when mcp is requested but no client is wired', () => {
		const log = vi.fn();
		const src = createLiveSource({ stateKey: 'series', source: 'mcp', name: 'getMetrics' }, undefined, log);
		expect(src).toBeInstanceOf(IntervalSnapshotSource);
		expect(log).toHaveBeenCalledOnce();
	});
});
