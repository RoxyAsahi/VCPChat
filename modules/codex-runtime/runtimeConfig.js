'use strict';

function normalizeApproval(permissionMode, approvalPolicy) {
    if (permissionMode === 'always-approve' || approvalPolicy === 'never') return 'never';
    return 'on-request';
}

function instructionShape(config = {}) {
    return {
        instructionMode: config.instructionMode || 'vchat-identity',
        baseInstructions: String(config.baseInstructions || ''),
        developerInstructions: String(config.developerInstructions || ''),
    };
}

function instructionConfigChanged(desired = {}, applied = {}) {
    return JSON.stringify(instructionShape(desired)) !== JSON.stringify(instructionShape(applied));
}

function requiresFreshCodexManagedSession(desired = {}, applied = {}) {
    return applied.instructionMode !== 'codex-managed'
        && desired.instructionMode === 'codex-managed'
        && Boolean(String(applied.baseInstructions || '').trim());
}

function threadSettingsPatch(session, desired = {}) {
    return {
        threadId: session.threadId,
        cwd: session.workspaceRoot || undefined,
        model: desired.model || undefined,
        approvalPolicy: normalizeApproval(desired.permissionMode, desired.approvalPolicy),
        ...(desired.reasoningEffort ? { effort: desired.reasoningEffort } : {}),
        ...(desired.instructionMode === 'codex-managed' && desired.personality && desired.personality !== 'none'
            ? { personality: desired.personality } : {}),
    };
}

module.exports = { instructionConfigChanged, requiresFreshCodexManagedSession, threadSettingsPatch };
