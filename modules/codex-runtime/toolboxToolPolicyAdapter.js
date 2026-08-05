'use strict';

const {
    allowsAnyVcpTool,
    nativeToolEnabled,
    normalizeToolPolicy,
} = require('./tool-policy');

const VCP_DYNAMIC_TOOL_NAME = 'vcp_invoke';

function adapterToolPolicy(value) {
    return normalizeToolPolicy(value == null ? {
        preset: 'custom',
        enabledCodexCapabilities: [],
        enabledVcpTools: ['vcp:*'],
    } : value);
}

function vcpInvokeChatTool() {
    return { type: 'function', function: {
        name: VCP_DYNAMIC_TOOL_NAME,
        description: 'Invoke one named VCPToolBox capability through the VCP bridge.',
        parameters: {
            type: 'object',
            properties: {
                tool: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
        },
    } };
}

function responsesToolsToChat(tools, toolPolicyValue) {
    if (!Array.isArray(tools)) return [];
    const toolPolicy = adapterToolPolicy(toolPolicyValue);
    let emittedVcpInvoke = false;
    return tools.flatMap((tool) => {
        if (!tool || tool.type !== 'function') return [];
        const name = String(tool.name || '').trim();
        if (name === VCP_DYNAMIC_TOOL_NAME) {
            if (emittedVcpInvoke || !allowsAnyVcpTool(toolPolicy)) return [];
            emittedVcpInvoke = true;
            return [vcpInvokeChatTool()];
        }
        if (!nativeToolEnabled(toolPolicy, name)) return [];
        return [{
            type: 'function',
            function: {
                name,
                description: String(tool.description || ''),
                parameters: tool.parameters && typeof tool.parameters === 'object'
                    ? tool.parameters : { type: 'object', properties: {} },
            },
        }];
    });
}

module.exports = { allowsAnyVcpTool, responsesToolsToChat, vcpInvokeChatTool };
