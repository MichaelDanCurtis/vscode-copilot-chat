/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	flushA2uiPendingEmits,
	flushSharedA2uiPendingEmits,
	setA2uiEmitDrain,
	getA2uiEmitDrain,
} from './a2uiEmitBridge';
import type { PendingEmit } from './surfaceManager';
import { URI as Uri } from '../../../util/vs/base/common/uri';

const FAKE_URI = Uri.file('/fake/runtime.js');
const rec = (surfaceId: string): PendingEmit => ({ surfaceId, runtimeUri: FAKE_URI, doc: { surfaceId }, version: 1 });

// ---------------------------------------------------------------------------
// Minimal PendingEmitDrain fake that honours both drain methods
// ---------------------------------------------------------------------------
function makeDrain(records: PendingEmit[] = []) {
	const store = new Map<string, PendingEmit>(records.map(r => [r.surfaceId, r]));
	return {
		drainPendingEmit: vi.fn((surfaceId: string) => {
			const r = store.get(surfaceId);
			if (r !== undefined) { store.delete(surfaceId); }
			return r;
		}),
		drainPendingEmits: vi.fn(() => {
			const all = [...store.values()];
			store.clear();
			return all;
		}),
	};
}

describe('flushA2uiPendingEmits (targeted drain — EMIT BRIDGE)', () => {
	it('replays the drained record for the requested surfaceId through stream.generativeUI', () => {
		const generativeUI = vi.fn();
		const drain = makeDrain([rec('a'), rec('b')]);
		flushA2uiPendingEmits(drain, { generativeUI }, 'a');
		expect(drain.drainPendingEmit).toHaveBeenCalledWith('a');
		expect(generativeUI).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledWith('a', FAKE_URI, { surfaceId: 'a' }, 1);
		// 'b' must still be in the drain (not touched)
		expect(drain.drainPendingEmit('b')).toEqual(rec('b'));
	});

	it('is a no-op when there is no stream (does not drain)', () => {
		const drain = makeDrain([rec('a')]);
		expect(() => flushA2uiPendingEmits(drain, undefined, 'a')).not.toThrow();
		// Without a stream we must NOT drain (would silently discard the surface).
		expect(drain.drainPendingEmit).not.toHaveBeenCalled();
	});

	it('is a no-op when drain is undefined', () => {
		const generativeUI = vi.fn();
		expect(() => flushA2uiPendingEmits(undefined, { generativeUI }, 'a')).not.toThrow();
		expect(generativeUI).not.toHaveBeenCalled();
	});

	it('does not call generativeUI when nothing is stashed for that surfaceId', () => {
		const generativeUI = vi.fn();
		const drain = makeDrain([]);
		flushA2uiPendingEmits(drain, { generativeUI }, 'missing');
		expect(generativeUI).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Cross-tool isolation
	// -------------------------------------------------------------------------

	it('cross-tool isolation: render_a2ui stashes S; a DIFFERENT tool does NOT emit S', () => {
		// Simulates: render_a2ui stashes 'surf-1'; another tool's hook fires for 'surf-2'
		// (or does not fire at all). The non-render_a2ui tool never calls flushA2uiPendingEmits,
		// but even if a stale call were made with a different id it must not emit S.
		const generativeUI = vi.fn();
		const drain = makeDrain([rec('surf-1')]);

		// A different tool would either not call flush at all, or call it with its own id
		flushA2uiPendingEmits(drain, { generativeUI }, 'surf-other');

		// surf-1 must NOT have been emitted
		expect(generativeUI).not.toHaveBeenCalled();
		// surf-1 still drainable (not accidentally consumed)
		expect(drain.drainPendingEmit('surf-1')).toEqual(rec('surf-1'));
	});

	// -------------------------------------------------------------------------
	// Two independent surfaces
	// -------------------------------------------------------------------------

	it('two surfaces: draining S1 emits only S1, leaves S2 intact; draining S2 emits S2', () => {
		const generativeUI = vi.fn();
		const drain = makeDrain([rec('S1'), rec('S2')]);

		// Drain S1 — only S1 emitted
		flushA2uiPendingEmits(drain, { generativeUI }, 'S1');
		expect(generativeUI).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledWith('S1', FAKE_URI, { surfaceId: 'S1' }, 1);

		generativeUI.mockClear();

		// Drain S2 — only S2 emitted
		flushA2uiPendingEmits(drain, { generativeUI }, 'S2');
		expect(generativeUI).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledWith('S2', FAKE_URI, { surfaceId: 'S2' }, 1);

		// Both now consumed — a second drain for each returns nothing
		const generativeUI3 = vi.fn();
		flushA2uiPendingEmits(drain, { generativeUI: generativeUI3 }, 'S1');
		flushA2uiPendingEmits(drain, { generativeUI: generativeUI3 }, 'S2');
		expect(generativeUI3).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Shared-instance wiring: setA2uiEmitDrain + flushSharedA2uiPendingEmits
// ---------------------------------------------------------------------------

describe('flushSharedA2uiPendingEmits (shared-instance wiring)', () => {
	beforeEach(() => {
		// Reset shared drain between tests
		setA2uiEmitDrain(undefined);
	});

	it('emits the correct record when drain is wired via setA2uiEmitDrain', () => {
		const drain = makeDrain([rec('wired-surf')]);
		setA2uiEmitDrain(drain);
		expect(getA2uiEmitDrain()).toBe(drain);

		const generativeUI = vi.fn();
		flushSharedA2uiPendingEmits('wired-surf', { generativeUI });

		expect(drain.drainPendingEmit).toHaveBeenCalledWith('wired-surf');
		expect(generativeUI).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledWith('wired-surf', FAKE_URI, { surfaceId: 'wired-surf' }, 1);
	});

	it('is a no-op when no drain is wired (A2UI not activated)', () => {
		const generativeUI = vi.fn();
		// _drain is undefined (set in beforeEach)
		expect(() => flushSharedA2uiPendingEmits('any', { generativeUI })).not.toThrow();
		expect(generativeUI).not.toHaveBeenCalled();
	});

	it('is a no-op when stream is absent (does not drain the shared instance)', () => {
		const drain = makeDrain([rec('s')]);
		setA2uiEmitDrain(drain);
		flushSharedA2uiPendingEmits('s', undefined);
		expect(drain.drainPendingEmit).not.toHaveBeenCalled();
	});

	it('emitting one surface does not consume another surfaceId on the shared drain', () => {
		const drain = makeDrain([rec('A'), rec('B')]);
		setA2uiEmitDrain(drain);
		const generativeUI = vi.fn();

		flushSharedA2uiPendingEmits('A', { generativeUI });
		expect(generativeUI).toHaveBeenCalledOnce();
		expect(generativeUI).toHaveBeenCalledWith('A', FAKE_URI, { surfaceId: 'A' }, 1);

		// B still drainable
		const generativeUI2 = vi.fn();
		flushSharedA2uiPendingEmits('B', { generativeUI: generativeUI2 });
		expect(generativeUI2).toHaveBeenCalledOnce();
		expect(generativeUI2).toHaveBeenCalledWith('B', FAKE_URI, { surfaceId: 'B' }, 1);
	});
});
