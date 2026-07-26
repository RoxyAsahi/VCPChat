'use strict';

const { LEGACY_TOOL_NAMES } = require('../contracts');
const { findSuspiciousPathArguments } = require('../workspacePolicy');

const HIGH_RISK_TOOL_PATTERN = /shell|powershell|bash|terminal|exec|write|delete|remove|git|browser|chrome|network|download|upload|install|credential|secret|token|everything/i;

const HIGH_RISK_COMMAND_PATTERN = /write|edit|append|create|copy|delete|remove|move|rename|execute|run|shell|terminal|install|uninstall|git\s*(push|reset|clean|commit)|format|kill|shutdown/i;
const FILE_OPERATOR_READ_COMMAND_PATTERN = /^(?:ReadFile|ReadMultipleFiles|ListDirectory|ListFiles|FileInfo|SearchFiles|GetDirectoryTree)$/i;

const PATCH_TOOL_RISK = Object.freeze({
    workspace_propose_patch: { riskLevel: 'medium', kind: 'workspace_proposal', requiresApproval: false, reasons: ['proposal does not write to disk'] },
    workspace_apply_patch: { riskLevel: 'high', kind: 'workspace_write', requiresApproval: true, reasons: ['applies approved content through VCP FileOperator'] },
    workspace_revert_patch: { riskLevel: 'high', kind: 'workspace_write', requiresApproval: true, reasons: ['reverts content through VCP FileOperator'] },
});

function classifyPatchTool(toolName) {
    const classification = PATCH_TOOL_RISK[toolName];
    if (classification) return { ...classification, reasons: classification.reasons.slice() };
    return { riskLevel: 'high', kind: 'unknown_patch', requiresApproval: true, reasons: [`unrecognized patch tool: ${toolName}`] };
}

function classifyLegacyTool(toolName, args = {}) {
    if (toolName === LEGACY_TOOL_NAMES.VCP_DELEGATE) {
        const task = String(args.task || '');
        return {
            riskLevel: HIGH_RISK_COMMAND_PATTERN.test(task) ? 'high' : 'medium',
            kind: 'vcp_delegate',
            requiresApproval: true,
            reasons: HIGH_RISK_COMMAND_PATTERN.test(task)
                ? ['delegate task mentions high-risk operations']
                : ['delegated execution happens inside VCPToolBox beyond client visibility'],
        };
    }
    if (toolName === LEGACY_TOOL_NAMES.VCP_INVOKE) {
        const target = String(args.toolName || '');
        const reasons = [];
        let riskLevel = 'medium';
        let requiresApproval = true;
        const innerArgs = args.arguments || {};
        const commandValues = Object.entries(innerArgs)
            .filter(([key]) => /^(?:command\d*|action)$/i.test(key))
            .map(([, value]) => String(value || ''))
            .filter(Boolean);
        const commandValue = commandValues.join(' ');
        if (/^FileOperator$/i.test(target) && commandValues.length === 1 && FILE_OPERATOR_READ_COMMAND_PATTERN.test(commandValue)) {
            riskLevel = 'low';
            requiresApproval = false;
            reasons.push(`workspace-scoped FileOperator read command: ${commandValue}`);
        }
        if (HIGH_RISK_TOOL_PATTERN.test(target)) {
            riskLevel = 'high';
            requiresApproval = true;
            reasons.push(`target tool matches high-risk pattern: ${target}`);
        }
        if (HIGH_RISK_COMMAND_PATTERN.test(commandValue)) {
            riskLevel = 'high';
            requiresApproval = true;
            reasons.push(`tool command matches high-risk pattern: ${commandValue.slice(0, 80)}`);
        }
        const suspiciousPaths = findSuspiciousPathArguments(innerArgs);
        if (suspiciousPaths.length > 0) {
            reasons.push(`arguments contain absolute/traversal paths: ${suspiciousPaths.map((f) => f.keyPath).join(', ')}`);
            if (riskLevel !== 'high') {
                riskLevel = 'high';
            }
            requiresApproval = true;
        }
        if (reasons.length === 0) {
            reasons.push('legacy vcp_invoke has no structured schema; human review required');
        }
        return { riskLevel, kind: 'vcp_tool', requiresApproval, reasons };
    }
    return {
        riskLevel: 'high',
        kind: 'unknown',
        requiresApproval: true,
        reasons: [`unrecognized runtime tool: ${toolName}`],
    };
}

module.exports = {
    classifyLegacyTool,
    classifyPatchTool,
    PATCH_TOOL_RISK,
    HIGH_RISK_TOOL_PATTERN,
    HIGH_RISK_COMMAND_PATTERN,
    FILE_OPERATOR_READ_COMMAND_PATTERN,
};
