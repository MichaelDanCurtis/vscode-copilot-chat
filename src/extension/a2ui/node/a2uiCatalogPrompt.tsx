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
import { ToolName } from '../../tools/common/toolNames';

/**
 * A compact, VALID worked example doc — a card containing a text + a chart.
 *
 * IMPORTANT: children are passed via `props.children` (an array of component-id
 * strings), NOT via the top-level `component.children` field. The `card`/`container`
 * catalog components read `props.children` and call `ctx.renderChild(id)` for each id
 * (see @copilot/a2ui-runtime src/catalog/layout.tsx). The top-level `component.children`
 * field exists in the type but the layout components ignore it, so children placed there
 * will validate but will NOT render. Keep this example in lockstep with that convention.
 */
const EXAMPLE_DOC = {
	version: 1,
	surfaceId: 'demo',
	root: 'root',
	components: {
		root: { id: 'root', type: 'card', props: { title: 'Sales', children: ['label', 'chart'] } },
		label: { id: 'label', type: 'text', props: { value: 'Q1 revenue' } },
		chart: { id: 'chart', type: 'chart', props: { dataKey: 'revenue', kind: 'bar', data: [3, 7, 5, 9] } },
	},
};

/**
 * System-message fragment that teaches the model the A2UI catalog so it can compose a
 * valid `render_a2ui` document on request (e.g. "draw me a dashboard / a card with a
 * chart"). It states the document envelope, the children convention, the live list of
 * component types (sourced dynamically from {@link getCatalogDescriptions} so adding a
 * catalog component later auto-updates what the model sees), and one worked example.
 *
 * Mounted into the agent system prompt by `AgentPrompt` (see
 * `src/extension/prompts/node/agent/agentPrompt.tsx`), gated on the `render_a2ui` tool
 * being available, so it costs nothing when the tool is not enabled.
 */
export class A2uiCatalogPrompt extends PromptElement<BasePromptElementProps> {
	override render(_state: void, _sizing: PromptSizing) {
		const entries = getCatalogDescriptions();
		return (
			<SystemMessage priority={this.props.priority ?? 800}>
				# Rendering UI with the {ToolName.RenderA2ui} tool<br />
				<br />
				When the user asks you to draw, render, sketch, or show a UI (a dashboard, a card, a chart, a form, a smiley, etc.), compose an A2UI document yourself and call the {ToolName.RenderA2ui} tool with it. Do NOT ask the user for JSON and do NOT claim a component type is unregistered — the available types are listed below.<br />
				<br />
				Call the tool with a single argument {`{ doc }`} where doc has this shape:<br />
				{`{ version: 1, surfaceId: string, root: <componentId>, components: { <id>: { id, type, props, children? } } }`}<br />
				<br />
				Rules:<br />
				- `root` must be the id of one of the entries in `components`.<br />
				- Every `components` key must equal that component's `id` field.<br />
				- `type` must be one of the known types listed below; any other type is rejected.<br />
				- IMPORTANT: layout components (`card`, `container`) take their children as an array of child component-ids in `props.children` (e.g. {`props: { children: ['a', 'b'] }`}). Each id in that array must be a key in `components`. Do not nest component objects inline.<br />
				<br />
				Known component types (you may only use these):<br />
				{entries
					.map(({ type, description }) => `- ${type}: ${description}\n`)
					.join('')}
				<br />
				Worked example — a card containing a text label and a bar chart:<br />
				{JSON.stringify(EXAMPLE_DOC, null, 2)}<br />
			</SystemMessage>
		);
	}
}
