/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	BasePromptElementProps,
	PromptElement,
	PromptSizing,
	SystemMessage,
} from '@vscode/prompt-tsx';
import { getCatalogDescriptions } from '@copilot/a2ui-runtime';

/**
 * System-message fragment that tells the model which A2UI component types it may
 * emit when calling the `render_a2ui` tool.
 *
 * TODO(phase5 / catalog-injection): this element is NOT yet mounted into any agent
 * system prompt. The agent prompt is model-family-specific (see
 * `src/extension/prompts/node/agent/*.tsx`), so there is no single clean insertion
 * point. Until it is rendered as a child of the active agent prompt, the model will
 * not autonomously know the A2UI catalog and must be told to call `render_a2ui`
 * explicitly (e.g. via a direct/forced tool invocation). This element is required
 * for autonomous tool selection but NOT for a direct-invocation smoke test.
 */
export class A2uiCatalogPrompt extends PromptElement<BasePromptElementProps> {
	override render(_state: void, _sizing: PromptSizing) {
		const entries = getCatalogDescriptions();
		return (
			<SystemMessage priority={800}>
				You may only render A2UI components of the following known
				<br />
				types. Do not emit any other component type.
				<br />
				{entries
					.map(({ type, description }) => `${type}: ${description}\n`)
					.join('')}
			</SystemMessage>
		);
	}
}
