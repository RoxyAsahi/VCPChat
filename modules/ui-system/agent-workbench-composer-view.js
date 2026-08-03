import { structuredWorkspacePaths } from './agent-workspace-model.js';
import { icon, node, visualActionButton } from './agent-workbench-dom.js';

function formatAttachmentSize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
    if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
    return `${value} B`;
}

function attachmentKindLabel(attachment) {
    switch (attachment?.kind) {
    case 'audio': return '音频';
    case 'video': return '视频';
    default: return '图片';
    }
}

function attachmentKindIcon(attachment) {
    switch (attachment?.kind) {
    case 'audio': return 'audiotrack';
    case 'video': return 'movie';
    default: return 'image';
    }
}

function attachmentMetadata(attachment) {
    const dimensions = attachment?.kind === 'image'
        ? `${attachment.width || '?'}×${attachment.height || '?'}`
        : attachmentKindLabel(attachment);
    return `${dimensions} · ${formatAttachmentSize(attachment?.byteLen)}`;
}

function createAttachmentChips(attachments, actions = {}, documentRef = globalThis.document) {
    const list = node('div', 'agent-chat-attachment-list', undefined, documentRef);
    list.setAttribute('aria-label', '媒体附件');
    attachments.forEach((attachment, index) => {
        const chip = node('div', 'agent-chat-attachment-chip', undefined, documentRef);
        const summary = node('div', 'agent-chat-attachment-summary', undefined, documentRef);
        summary.append(
            ...icon(attachmentKindIcon(attachment), undefined, documentRef),
            node('span', 'agent-chat-attachment-name', attachment.displayName || attachmentKindLabel(attachment), documentRef),
            node('span', 'agent-chat-attachment-meta', attachmentMetadata(attachment), documentRef),
        );
        chip.append(summary);
        const relativePath = structuredWorkspacePaths(attachment, 1)[0];
        if (relativePath && typeof actions.openWorkspacePath === 'function') {
            const open = visualActionButton('draft', `在工作区预览 ${relativePath}`, 'agent-chat-attachment-open-workspace', '', documentRef);
            open.addEventListener('click', () => actions.openWorkspacePath(relativePath));
            chip.append(open);
        }
        if (typeof actions.remove === 'function') {
            const remove = visualActionButton('close', `移除 ${attachment.displayName || '附件'}`, 'agent-chat-attachment-remove', '', documentRef);
            remove.addEventListener('click', () => actions.remove(index));
            chip.append(remove);
        }
        list.append(chip);
    });
    return list;
}

function createAgentWorkbenchComposerView({ refs, document = globalThis.document }) {
    const {
        input, sendButton, attachButton, attachmentTray, inputCard, runningModes,
        steerModeButton, followUpModeButton, composerConfig, permissionsButton, newButton,
    } = refs;

    function update(model = {}) {
        input.value = model.draft || '';
        input.disabled = Boolean(model.inputDisabled);
        sendButton.disabled = Boolean(model.sendDisabled);
        attachButton.disabled = Boolean(model.attachDisabled);
        attachmentTray.replaceChildren();
        if (model.attachments?.length) {
            attachmentTray.append(createAttachmentChips(model.attachments, {
                remove: model.removeAttachment,
                openWorkspacePath: model.openWorkspacePath,
            }, document));
        }
        sendButton.title = model.sendTitle || '发送消息';
        sendButton.setAttribute('aria-label', model.sendLabel || model.sendTitle || '发送消息');
        const sendIcon = sendButton.querySelector('.vcp-ui-icon');
        if (sendIcon) sendIcon.textContent = 'arrow_upward';
        input.placeholder = model.placeholder || '输入消息…（Shift + Enter 换行）';
        inputCard.classList.toggle('is-busy', Boolean(model.busy));
        sendButton.classList.remove('interrupt-mode');
        sendButton.classList.toggle('is-ready', Boolean(model.ready));
        runningModes.hidden = !model.busy;
        steerModeButton.classList.toggle('is-active', model.inputMode === 'steer');
        followUpModeButton.classList.toggle('is-active', model.inputMode === 'follow-up');
        composerConfig.textContent = model.configText || '';
        composerConfig.disabled = Boolean(model.configDisabled);
        permissionsButton.title = model.permissionLabel || '本地审批';
        permissionsButton.setAttribute('aria-label', model.permissionLabel || '本地审批');
        permissionsButton.classList.toggle('is-active', Boolean(model.permissionActive));
        newButton.disabled = Boolean(model.newDisabled);
    }

    return { element: refs.composer, update, dispose() {} };
}

export { createAgentWorkbenchComposerView, createAttachmentChips };
