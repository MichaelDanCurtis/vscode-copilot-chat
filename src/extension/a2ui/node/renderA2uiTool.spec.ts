/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { RenderA2uiTool } from './renderA2uiTool';

const good = { version: 1, surfaceId: 's1', root: 't', components: { t: { id: 't', type: 'text', props: { value: 'hi' } } } };

describe('RenderA2uiTool', () => {
	it('emits generativeUI for a valid doc', async () => {
		const stream = { generativeUI: vi.fn() } as any;
		const surfaces = { register: vi.fn().mockReturnValue({ runtimeUri: { toString: () => 'file:///r.js' } }) } as any;
		const tool = new RenderA2uiTool(surfaces);
		const res = await tool.invokeWith({ doc: good } as any, stream);
		expect(stream.generativeUI).toHaveBeenCalledWith('s1', expect.anything(), good, 1);
		expect(res.ok).toBe(true);
	});
	it('returns validation errors for a bad doc and does NOT emit', async () => {
		const stream = { generativeUI: vi.fn() } as any;
		const surfaces = { register: vi.fn() } as any;
		const tool = new RenderA2uiTool(surfaces);
		const res = await tool.invokeWith({ doc: { ...good, components: { t: { id: 't', type: 'nope', props: {} } } } } as any, stream);
		expect(stream.generativeUI).not.toHaveBeenCalled();
		expect(res.ok).toBe(false);
	});
});
