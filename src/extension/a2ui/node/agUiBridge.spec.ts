/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { AgUiBridge, type SurfaceChannel } from './agUiBridge';
import type { HostToInsetMessage, InsetToHostMessage } from '@copilot/a2ui-runtime';

// Extract the patch element type from the STATE_DELTA message variant
type StateDeltaMsg = Extract<HostToInsetMessage, { type: 'STATE_DELTA' }>;
type PatchOp = StateDeltaMsg['patch'][number];

const makePatch = (): PatchOp[] => [{ op: 'replace', path: '/foo', value: 42 }];

function makeFakeChannel(): { channel: SurfaceChannel; posts: Array<[string, HostToInsetMessage]> } {
	const posts: Array<[string, HostToInsetMessage]> = [];
	const channel: SurfaceChannel = { post: (surfaceId, msg) => { posts.push([surfaceId, msg]); } };
	return { channel, posts };
}

describe('AgUiBridge', () => {
	describe('emitStateDelta', () => {
		it('calls channel.post with a STATE_DELTA message wrapping the patch', () => {
			const { channel, posts } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const patch = makePatch();

			bridge.emitStateDelta('surface-1', patch);

			expect(posts).toHaveLength(1);
			const [postedId, postedMsg] = posts[0];
			expect(postedId).toBe('surface-1');
			expect(postedMsg).toEqual({ type: 'STATE_DELTA', surfaceId: 'surface-1', patch });
		});

		it('passes the surfaceId and patch through without mutation', () => {
			const { channel, posts } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const patch = makePatch();
			const patchRef = patch;

			bridge.emitStateDelta('s2', patch);

			expect(posts[0][1]).toStrictEqual({ type: 'STATE_DELTA', surfaceId: 's2', patch: patchRef });
		});
	});

	describe('onInteraction + handleInsetMessage', () => {
		it('invokes the registered handler when an INTERACTION message arrives', () => {
			const { channel } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const handler = vi.fn();
			bridge.onInteraction(handler);

			const msg: InsetToHostMessage = {
				type: 'INTERACTION',
				surfaceId: 's1',
				componentId: 'btn',
				binding: 'mcp',
				payload: { clicked: true },
			};
			bridge.handleInsetMessage(msg);

			expect(handler).toHaveBeenCalledOnce();
			expect(handler).toHaveBeenCalledWith(msg);
		});

		it('does NOT invoke the handler for READY messages', () => {
			const { channel } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const handler = vi.fn();
			bridge.onInteraction(handler);

			const msg: InsetToHostMessage = { type: 'READY', surfaceId: 's1' };
			bridge.handleInsetMessage(msg);

			expect(handler).not.toHaveBeenCalled();
		});

		it('does NOT invoke the handler for RESIZE messages', () => {
			const { channel } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const handler = vi.fn();
			bridge.onInteraction(handler);

			const msg: InsetToHostMessage = { type: 'RESIZE', surfaceId: 's1', height: 300 };
			bridge.handleInsetMessage(msg);

			expect(handler).not.toHaveBeenCalled();
		});

		it('works with no handler registered (no throw)', () => {
			const { channel } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);

			const msg: InsetToHostMessage = {
				type: 'INTERACTION',
				surfaceId: 's1',
				componentId: 'btn',
				binding: 'agent',
				payload: null,
			};
			expect(() => bridge.handleInsetMessage(msg)).not.toThrow();
		});

		it('replaces a previously registered handler when onInteraction is called again', () => {
			const { channel } = makeFakeChannel();
			const bridge = new AgUiBridge(channel);
			const first = vi.fn();
			const second = vi.fn();
			bridge.onInteraction(first);
			bridge.onInteraction(second);

			const msg: InsetToHostMessage = {
				type: 'INTERACTION',
				surfaceId: 's1',
				componentId: 'btn',
				binding: 'mcp',
				payload: {},
			};
			bridge.handleInsetMessage(msg);

			expect(first).not.toHaveBeenCalled();
			expect(second).toHaveBeenCalledOnce();
		});
	});
});
