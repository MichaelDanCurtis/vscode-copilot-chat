/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { validateDocument, type A2uiDocument } from '@copilot/a2ui-runtime';

/**
 * Narrow interface for surface registration. Task 3.6's SurfaceManager will implement this.
 * Defined here to avoid importing SurfaceManager (Task 3.6) before it exists.
 */
export interface SurfaceRegistrar {
	register(surfaceId: string): { runtimeUri: import('vscode').Uri };
}

/** Minimal stream shape this tool needs to emit a generative-UI inset part. */
export interface GenerativeUIEmitter {
	generativeUI(surfaceId: string, runtimeUri: import('vscode').Uri, initialDoc?: object, version?: number): void;
}

interface IRenderA2uiInput {
	doc: A2uiDocument;
}

/**
 * Tool that renders an A2UI document as an in-bubble generative-UI inset.
 *
 * IMPORTANT — two invocation paths exist because of a VS Code API constraint:
 *
 *  1. {@link invokeWith} is the path that actually emits the inset. It requires
 *     a {@link GenerativeUIEmitter} (a `ChatResponseStream` carrying the proposed
 *     `generativeUI()` method). Only a chat-participant request handler owns such
 *     a stream, so this path is driven by the agent/participant layer.
 *
 *  2. {@link invoke} is the standard `vscode.LanguageModelTool.invoke(options, token)`
 *     entry point used when the tool is registered via `vscode.lm.registerTool`.
 *     The Language-Model Tool API does NOT pass a `ChatResponseStream` to a tool —
 *     `invoke` only receives `options` (input + metadata) and a token, and may only
 *     return a `LanguageModelToolResult`. Therefore `invoke` validates the document
 *     and registers the surface (reserving its runtime URI), but it CANNOT itself
 *     emit the inset. The actual `stream.generativeUI(...)` call must happen in the
 *     participant handler that owns the stream (see wiring-report Part B / Phase 5).
 */
export class RenderA2uiTool implements vscode.LanguageModelTool<IRenderA2uiInput> {
	constructor(private readonly surfaces: SurfaceRegistrar) { }

	/**
	 * Stream-bearing path: validates, registers the surface, and emits the inset.
	 * Used by the chat-participant handler (or tests) that owns a real
	 * `ChatResponseStream`.
	 */
	async invokeWith(input: IRenderA2uiInput, stream: GenerativeUIEmitter): Promise<{ ok: boolean; message: string }> {
		const v = validateDocument(input.doc);
		if (!v.ok) { return { ok: false, message: `A2UI invalid: ${v.errors.join('; ')}` }; }
		const { runtimeUri } = this.surfaces.register(input.doc.surfaceId);
		stream.generativeUI(input.doc.surfaceId, runtimeUri, input.doc, input.doc.version);
		return { ok: true, message: `Rendered surface ${input.doc.surfaceId}` };
	}

	/**
	 * Standard `vscode.lm.registerTool` entry point. No stream is available here
	 * (see class doc), so this validates and reserves the surface but does not
	 * emit the inset. Returns a textual result the agent loop can render/inspect.
	 */
	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRenderA2uiInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const input = options.input;
		const v = validateDocument(input.doc);
		if (!v.ok) {
			return new LanguageModelToolResult([new LanguageModelTextPart(`A2UI invalid: ${v.errors.join('; ')}`)]);
		}
		// Reserve the surface + runtime URI. The in-bubble emit (stream.generativeUI)
		// must be performed by the participant handler that owns the stream.
		this.surfaces.register(input.doc.surfaceId);
		return new LanguageModelToolResult([new LanguageModelTextPart(`Rendered surface ${input.doc.surfaceId}`)]);
	}
}
