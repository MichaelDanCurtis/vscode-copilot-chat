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

describe('A2uiCatalogPrompt', () => {
	it('rendered output contains every catalog type name', async () => {
		const element = new A2uiCatalogPrompt({});
		const rendered = await element.render(undefined, stubSizing);
		const output = JSON.stringify(rendered);
		for (const { type } of getCatalogDescriptions()) {
			expect(output).toContain(type);
		}
	});

	it('rendered output contains every catalog description', async () => {
		const element = new A2uiCatalogPrompt({});
		const rendered = await element.render(undefined, stubSizing);
		const output = JSON.stringify(rendered);
		for (const { description } of getCatalogDescriptions()) {
			expect(output).toContain(description);
		}
	});
});
