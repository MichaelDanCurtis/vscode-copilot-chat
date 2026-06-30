/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import { flushA2uiPendingEmits } from './a2uiEmitBridge';
import type { PendingEmit } from './surfaceManager';
import { URI as Uri } from '../../../util/vs/base/common/uri';

const FAKE_URI = Uri.file('/fake/runtime.js');
const rec = (surfaceId: string): PendingEmit => ({ surfaceId, runtimeUri: FAKE_URI, doc: { surfaceId }, version: 1 });

describe('flushA2uiPendingEmits (EMIT BRIDGE)', () => {
	it('replays each drained record through stream.generativeUI in order', () => {
		const generativeUI = vi.fn();
		const drain = { drainPendingEmits: vi.fn().mockReturnValue([rec('a'), rec('b')]) };
		flushA2uiPendingEmits(drain, { generativeUI });
		expect(drain.drainPendingEmits).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledTimes(2);
		expect(generativeUI).toHaveBeenNthCalledWith(1, 'a', FAKE_URI, { surfaceId: 'a' }, 1);
		expect(generativeUI).toHaveBeenNthCalledWith(2, 'b', FAKE_URI, { surfaceId: 'b' }, 1);
	});

	it('is a no-op when there is no stream (still safe)', () => {
		const drain = { drainPendingEmits: vi.fn().mockReturnValue([rec('a')]) };
		expect(() => flushA2uiPendingEmits(drain, undefined)).not.toThrow();
		// Without a stream we must NOT drain (would silently discard the surface).
		expect(drain.drainPendingEmits).not.toHaveBeenCalled();
	});

	it('does not call generativeUI when nothing is stashed', () => {
		const generativeUI = vi.fn();
		const drain = { drainPendingEmits: vi.fn().mockReturnValue([]) };
		flushA2uiPendingEmits(drain, { generativeUI });
		expect(generativeUI).not.toHaveBeenCalled();
	});
});
