/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {

	export interface ChatResponseStream {

		/**
		 * Emits a generative-UI inset part rendered in-bubble by the core fork.
		 * @param surfaceId Stable identifier for this UI surface (used to route updates).
		 * @param runtimeUri URI of the AG-UI runtime bundle to load for this surface.
		 * @param initialDoc Optional initial document state passed to the runtime.
		 * @param version Optional schema version of the document; defaults to 1.
		 */
		generativeUI(surfaceId: string, runtimeUri: Uri, initialDoc?: object, version?: number): void;
	}
}
