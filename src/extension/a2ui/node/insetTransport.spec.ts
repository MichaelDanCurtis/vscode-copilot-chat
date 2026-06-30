/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { HostToInsetMessage } from '@copilot/a2ui-runtime';
import { createInsetTransport, POST_TO_SURFACE_COMMAND } from './insetTransport';

describe('insetTransport', () => {
	it('post() invokes the _a2ui.postToSurface command with (surfaceId, msg)', () => {
		const executeCommand = vi.fn().mockResolvedValue(undefined);
		const transport = createInsetTransport(executeCommand);

		const msg: HostToInsetMessage = { type: 'STATE_DELTA', surfaceId: 'surf-1', patch: [{ op: 'replace', path: '/x', value: 1 }] };
		transport.post('surf-1', msg);

		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledWith(POST_TO_SURFACE_COMMAND, 'surf-1', msg);
		expect(POST_TO_SURFACE_COMMAND).toBe('_a2ui.postToSurface');
	});

	it('forwards DISPOSE messages through the same command', () => {
		const executeCommand = vi.fn().mockResolvedValue(undefined);
		const transport = createInsetTransport(executeCommand);

		const msg: HostToInsetMessage = { type: 'DISPOSE', surfaceId: 'surf-2' };
		transport.post('surf-2', msg);

		expect(executeCommand).toHaveBeenCalledWith('_a2ui.postToSurface', 'surf-2', msg);
	});
});
