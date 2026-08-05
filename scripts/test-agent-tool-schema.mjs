import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderAgentToolSchema } from '../modules/ui-system/agent-tool-schema-view.js';

const dom = new JSDOM('<!doctype html><body></body>');
const { document } = dom.window;
const node = (tag, className = '', text = '') => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
};
const context = { document, node };

const empty = renderAgentToolSchema(context, { sessionId: 'session-a', diagnostics: {} });
assert.match(empty.textContent, /还没有真实请求/);

const schema = renderAgentToolSchema(context, {
    sessionId: 'session-a',
    diagnostics: { toolbox: { adapter: { recentRequests: [{
        model: 'Nova', status: 'completed', startedAt: 1_700_000_000_000,
        forwardedToolSchemas: [{
            type: 'function', name: 'vcp_invoke', description: 'Invoke a VCP tool.',
            parameters: {
                type: 'object',
                properties: {
                    tool: { type: 'string' },
                    arguments: { type: 'object' },
                },
                required: ['tool'],
            },
        }],
    }] } } },
});
assert.match(schema.textContent, /Nova/);
assert.match(schema.textContent, /vcp_invoke/);
assert.match(schema.textContent, /2 个字段/);
assert.match(schema.textContent, /必填/);
assert.match(schema.querySelector('.agent-tool-schema-json')?.textContent || '', /"parameters"/);

const noTools = renderAgentToolSchema(context, {
    sessionId: 'session-a',
    diagnostics: { toolbox: { adapter: { recentRequests: [{
        model: 'Nova', status: 'completed', forwardedToolSchemas: [],
    }] } } },
});
assert.match(noTools.textContent, /本轮没有开放工具/);

console.log('Agent tool schema view tests passed.');
