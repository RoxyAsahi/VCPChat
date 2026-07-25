'use strict';

const { LEGACY_TOOL_NAMES } = require('../contracts');
const { findSuspiciousPathArguments } = require('../workspacePolicy');

const HIGH_RISK_TOOL_PATTERN = /shell|powershell|bash|terminal|exec|write|delete|remove|git|browser|chrome|network|download|upload|install|credential|secret|token|fileoperator|everything/i;

const HIGH_RISK_COMMAND_PATTERN = /write|delete|remove|move|rename|execute|run|shell|terminal|install|uninstall|git\s*(push|reset|clean|commit)|format|kill|shutdown/i;

function classifyLegacyTool(toolName, args = {}) {
    if (toolName === LEGACY_TOOL_NAMES.VCP_DELEGATE) {
        const task = String(args.task || '');
        return {
            riskLevel: HIGH_RISK_COMMAND_PATTERN.test(task) ? 'high' : 'medium',
            kind: 'vcp_delegate',
            reasons: HIGH_RISK_COMMAND_PATTERN.test(task)
                ? ['delegate task mentions high-risk operations']
                : ['delegated execution happens inside VCPToolBox beyond client visibility'],
        };
    }
    if (toolName === LEGACY_TOOL_NAMES.VCP_INVOKE) {
        const target = String(args.toolName || '');
        const reasons = [];
        let riskLevel = 'medium';
        if (HIGH_RISK_TOOL_PATTERN.test(target)) {
            riskLevel = 'high';
            reasons.push(`target tool matches high-risk pattern: ${target}`);
        }
        const innerArgs = args.arguments || {};
        const commandValue = String(innerArgs.command || innerArgs.action || '');
        if (HIGH_RISK_COMMAND_PATTERN.test(commandValue)) {
            riskLevel = 'high';
            reasons.push(`tool command matches high-risk pattern: ${commandValue.slice(0, 80)}`);
        }
        const suspiciousPaths = findSuspiciousPathArguments(innerArgs);
        if (suspiciousPaths.length > 0) {
            reasons.push(`arguments contain absolute/traversal paths: ${suspiciousPaths.map((f) => f.keyPath).join(', ')}`);
            if (riskLevel !== 'high') {
                riskLevel = 'high';
            }
        }
        if (reasons.length === 0) {
            reasons.push('legacy vcp_invoke has no structured schema; human review required');
        }
        return { riskLevel, kind: 'vcp_tool', reasons };
    }
    return {
        riskLevel: 'high',
        kind: 'unknown',
        reasons: [`unrecognized runtime tool: ${toolName}`],
    };
}

module.exports = {
    classifyLegacyTool,
    HIGH_RISK_TOOL_PATTERN,
    HIGH_RISK_COMMAND_PATTERN,
};
