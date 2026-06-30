/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { RenderA2uiTool } from './renderA2uiTool';

const good = { version: 1, surfaceId: 's1', root: 't', components: { t: { id: 't', type: 'text', props: { value: 'hi' } } } };
const bad = { ...good, components: { t: { id: 't', type: 'nope', props: {} } } };

function makeSurfaces() {
	const runtimeUri = { toString: () => 'file:///r.js' } as any;
	return {
		register: vi.fn().mockReturnValue({ runtimeUri }),
		stashPendingEmit: vi.fn(),
		runtimeUri,
	} as any;
}

describe('RenderA2uiTool', () => {
	it('emits generativeUI for a valid doc', async () => {
		const stream = { generativeUI: vi.fn() } as any;
		const surfaces = makeSurfaces();
		const tool = new RenderA2uiTool(surfaces);
		const res = await tool.invokeWith({ doc: good } as any, stream);
		expect(stream.generativeUI).toHaveBeenCalledWith('s1', expect.anything(), good, 1);
		expect(res.ok).toBe(true);
	});
	it('returns validation errors for a bad doc and does NOT emit', async () => {
		const stream = { generativeUI: vi.fn() } as any;
		const surfaces = makeSurfaces();
		const tool = new RenderA2uiTool(surfaces);
		const res = await tool.invokeWith({ doc: bad } as any, stream);
		expect(stream.generativeUI).not.toHaveBeenCalled();
		expect(res.ok).toBe(false);
	});

	describe('invoke() (stream-less path) — EMIT BRIDGE stash', () => {
		it('reserves the surface AND stashes a pending-emit for a valid doc', async () => {
			const surfaces = makeSurfaces();
			const tool = new RenderA2uiTool(surfaces);
			await tool.invoke({ input: { doc: good } } as any, {} as any);
			expect(surfaces.register).toHaveBeenCalledWith('s1');
			expect(surfaces.stashPendingEmit).toHaveBeenCalledOnce();
			expect(surfaces.stashPendingEmit).toHaveBeenCalledWith({
				surfaceId: 's1',
				runtimeUri: surfaces.runtimeUri,
				doc: good,
				version: 1,
			});
		});
		it('does NOT stash (or register) for an invalid doc', async () => {
			const surfaces = makeSurfaces();
			const tool = new RenderA2uiTool(surfaces);
			await tool.invoke({ input: { doc: bad } } as any, {} as any);
			expect(surfaces.register).not.toHaveBeenCalled();
			expect(surfaces.stashPendingEmit).not.toHaveBeenCalled();
		});
	});
});
