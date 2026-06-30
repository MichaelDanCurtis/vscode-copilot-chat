/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptSizing } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import { getCatalogDescriptions } from '@copilot/a2ui-runtime';
import { A2uiCatalogPrompt } from './a2uiCatalogPrompt';

/** Minimal stub satisfying PromptSizing for unit tests that don't need token budgeting. */
const stubSizing = {
	tokenBudget: 4096,
	countTokens: async () => 0,
	endpoint: {},
} as unknown as PromptSizing;

async function renderText(): Promise<string> {
	const element = new A2uiCatalogPrompt({});
	const rendered = await element.render(undefined, stubSizing);
	return JSON.stringify(rendered);
}

describe('A2uiCatalogPrompt', () => {
	it('rendered output contains every catalog type name (iterates the live catalog so it scales)', async () => {
		const output = await renderText();
		const types = getCatalogDescriptions();
		expect(types.length).toBeGreaterThan(0);
		for (const { type } of types) {
			expect(output).toContain(type);
		}
	});

	it('rendered output contains every catalog description', async () => {
		const output = await renderText();
		for (const { description } of getCatalogDescriptions()) {
			expect(output).toContain(description);
		}
	});

	it('states the document envelope shape', async () => {
		const output = await renderText();
		// The envelope keys the model must produce.
		expect(output).toContain('version');
		expect(output).toContain('surfaceId');
		expect(output).toContain('root');
		expect(output).toContain('components');
	});

	it('states the props.children convention for layout components', async () => {
		const output = await renderText();
		expect(output).toContain('props.children');
	});

	it('includes a worked example with a card, a text, and a chart', async () => {
		const output = await renderText();
		expect(output).toContain('card');
		expect(output).toContain('text');
		expect(output).toContain('chart');
		// The example wires children by id via props.children.
		expect(output).toContain('children');
	});

	it('references the render_a2ui tool by name', async () => {
		const output = await renderText();
		expect(output).toContain('render_a2ui');
	});
});
