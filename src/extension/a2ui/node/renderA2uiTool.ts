/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { validateDocument, type A2uiDocument } from '@copilot/a2ui-runtime';

/**
 * Narrow interface for surface registration. Task 3.6's SurfaceManager will implement this.
 * Defined here to avoid importing SurfaceManager (Task 3.6) before it exists.
 */
export interface SurfaceRegistrar {
	register(surfaceId: string): { runtimeUri: import('vscode').Uri };
}

export class RenderA2uiTool {
	constructor(private readonly surfaces: SurfaceRegistrar) { }

	async invokeWith(input: { doc: A2uiDocument }, stream: { generativeUI: Function }): Promise<{ ok: boolean; message: string }> {
		const v = validateDocument(input.doc);
		if (!v.ok) { return { ok: false, message: `A2UI invalid: ${v.errors.join('; ')}` }; }
		const { runtimeUri } = this.surfaces.register(input.doc.surfaceId);
		stream.generativeUI(input.doc.surfaceId, runtimeUri, input.doc, input.doc.version);
		return { ok: true, message: `Rendered surface ${input.doc.surfaceId}` };
	}
}
