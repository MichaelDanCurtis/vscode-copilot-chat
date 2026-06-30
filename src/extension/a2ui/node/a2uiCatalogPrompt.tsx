/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, SystemMessage } from '@vscode/prompt-tsx';
import { getCatalogDescriptions } from '@copilot/a2ui-runtime';

export class A2uiCatalogPrompt extends PromptElement<BasePromptElementProps> {
	override render(_state: void, _sizing: PromptSizing) {
		const entries = getCatalogDescriptions();
		return (
			<SystemMessage priority={800}>
				You may only render A2UI components of the following known types. Do not emit any other component type.<br />
				{entries.map(({ type, description }) => `${type}: ${description}\n`).join('')}
			</SystemMessage>
		);
	}
}
