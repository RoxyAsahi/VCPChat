'use strict';

const TOOL_POLICY_SCHEMA_VERSION = 1;
const TOOL_PRESETS = new Set(['full', 'readonly', 'custom']);
const CODEX_CAPABILITIES = Object.freeze({
    SHELL: 'codex:shell-command',
    WORKSPACE_WRITE: 'codex:workspace-write',
    VIEW_IMAGE: 'codex:view-image',
    PLAN: 'codex:plan',
});
const ALL_CODEX_CAPABILITIES = Object.freeze(Object.values(CODEX_CAPABILITIES));
const READONLY_CODEX_CAPABILITIES = Object.freeze([
    CODEX_CAPABILITIES.VIEW_IMAGE,
    CODEX_CAPABILITIES.PLAN,
]);
const NATIVE_TOOL_CAPABILITY = Object.freeze({
    shell_command: CODEX_CAPABILITIES.SHELL,
    apply_patch: CODEX_CAPABILITIES.WORKSPACE_WRITE,
    view_image: CODEX_CAPABILITIES.VIEW_IMAGE,
    update_plan: CODEX_CAPABILITIES.PLAN,
    create_goal: CODEX_CAPABILITIES.PLAN,
    get_goal: CODEX_CAPABILITIES.PLAN,
    update_goal: CODEX_CAPABILITIES.PLAN,
});

function uniqueStrings(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeToolPolicy(value = null) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const preset = TOOL_PRESETS.has(source.preset) ? source.preset : 'full';
    return {
        schemaVersion: TOOL_POLICY_SCHEMA_VERSION,
        preset,
        enabledCodexCapabilities: uniqueStrings(source.enabledCodexCapabilities)
            .filter((id) => ALL_CODEX_CAPABILITIES.includes(id)),
        enabledVcpTools: uniqueStrings(source.enabledVcpTools),
    };
}

function isCodexCapabilityEnabled(policyValue, capabilityId) {
    const policy = normalizeToolPolicy(policyValue);
    if (policy.preset === 'full') return ALL_CODEX_CAPABILITIES.includes(capabilityId);
    if (policy.preset === 'readonly') return READONLY_CODEX_CAPABILITIES.includes(capabilityId);
    return policy.enabledCodexCapabilities.includes(capabilityId);
}

function vcpToolId(pluginId, command = '') {
    const plugin = String(pluginId || '').trim();
    const commandName = String(command || '').trim();
    return commandName ? `vcp:${plugin}:${commandName}` : `vcp:${plugin}`;
}

function isReadOnlyVcpCommand(command) {
    const value = String(command || '').trim();
    return /^(list|read|search|find|get|query|inspect|view|stat|status|info|describe|lookup|check)/i.test(value)
        && !/(write|edit|append|apply|delete|remove|move|rename|copy|create|download|upload|execute|run|control|send|set|update)/i.test(value);
}

function isVcpToolEnabled(policyValue, pluginId, command = '') {
    const policy = normalizeToolPolicy(policyValue);
    if (policy.preset === 'full') return true;
    if (policy.preset === 'readonly') return isReadOnlyVcpCommand(command);
    const pluginKey = vcpToolId(pluginId);
    const commandKey = vcpToolId(pluginId, command);
    return policy.enabledVcpTools.includes(pluginKey) || policy.enabledVcpTools.includes(commandKey);
}

function allowsAnyVcpTool(policyValue) {
    const policy = normalizeToolPolicy(policyValue);
    if (policy.preset === 'full' || policy.preset === 'readonly') return true;
    return policy.enabledVcpTools.length > 0;
}

function nativeToolEnabled(policyValue, toolName) {
    const capability = NATIVE_TOOL_CAPABILITY[String(toolName || '').trim()];
    return Boolean(capability && isCodexCapabilityEnabled(policyValue, capability));
}

module.exports = {
    ALL_CODEX_CAPABILITIES,
    CODEX_CAPABILITIES,
    NATIVE_TOOL_CAPABILITY,
    READONLY_CODEX_CAPABILITIES,
    TOOL_POLICY_SCHEMA_VERSION,
    allowsAnyVcpTool,
    isCodexCapabilityEnabled,
    isReadOnlyVcpCommand,
    isVcpToolEnabled,
    nativeToolEnabled,
    normalizeToolPolicy,
    vcpToolId,
};
