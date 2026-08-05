'use strict';

const path = require('path');

function normalizeApproval(permissionMode, approvalPolicy) {
    if (permissionMode === 'always-approve' || approvalPolicy === 'never') return 'never';
    return 'on-request';
}

function normalizePath(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const resolved = path.resolve(text);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function runtimeSettingsTarget(session, config = {}) {
    return {
        cwd: config.workspaceRoot || session.workspaceRoot || null,
        model: config.model || null,
        approvalPolicy: normalizeApproval(config.permissionMode, config.approvalPolicy),
        effort: config.reasoningEffort || null,
        personality: config.instructionMode === 'codex-managed'
            && config.personality && config.personality !== 'none' ? config.personality : null,
    };
}

function threadSettingsPatch(session, desired = {}) {
    const target = runtimeSettingsTarget(session, desired);
    return {
        threadId: session.threadId,
        cwd: target.cwd,
        model: target.model,
        approvalPolicy: target.approvalPolicy,
        effort: target.effort,
        personality: target.personality,
    };
}

function runtimeSettingsFromNotification(settings = {}) {
    return {
        cwd: settings.cwd || null,
        model: settings.model || null,
        approvalPolicy: settings.approvalPolicy || null,
        effort: settings.effort ?? null,
        personality: settings.personality ?? null,
    };
}

function runtimeSettingsFromResume(result = {}) {
    return {
        cwd: result.cwd || null,
        model: result.model || null,
        approvalPolicy: result.approvalPolicy || null,
        effort: result.reasoningEffort ?? null,
    };
}

function sameRuntimeSettings(left = {}, right = {}, { includePersonality = true } = {}) {
    const fields = ['model', 'approvalPolicy', 'effort', ...(includePersonality ? ['personality'] : [])];
    return normalizePath(left.cwd) === normalizePath(right.cwd)
        && fields.every((field) => (left[field] ?? null) === (right[field] ?? null));
}

module.exports = {
    runtimeSettingsFromNotification,
    runtimeSettingsFromResume,
    runtimeSettingsTarget,
    sameRuntimeSettings,
    threadSettingsPatch,
};
