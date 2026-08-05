import { button, iconButton, node, visualActionButton } from './agent-workbench-dom.js';

function createAgentWorkbenchShellView({ document, container, state, actions = {} }) {
    const disposers = [];
    const listen = (target, type, listener, options) => {
        target.addEventListener(type, listener, options);
        disposers.push(() => target.removeEventListener(type, listener, options));
    };

    const root = node('section', 'container agent-chat-root vcp-ui-scope', undefined, document);
    root.dataset.presentationRenderer = 'fork';
    const topicFlowLayer = node('div', 'vcp-ui-scope agent-chat-topic-flow-layer', undefined, document);
    const sidebar = node('aside', 'sidebar active vcp-ui-scope agent-chat-sidebar', undefined, document);
    const sidebarSplitter = node('div', 'agent-chat-sidebar-splitter', undefined, document);
    sidebarSplitter.tabIndex = 0;
    sidebarSplitter.setAttribute('role', 'separator');
    sidebarSplitter.setAttribute('aria-orientation', 'vertical');
    sidebarSplitter.setAttribute('aria-label', '调整 Agent 侧栏宽度');
    const main = node('main', 'main-content agent-chat-main-content agent-chat-pane', undefined, document);
    const feed = node('div', 'chat-messages-container vcp-ui-scope agent-chat-messages-container', undefined, document);
    const feedItems = node('div', 'chat-messages agent-chat-messages', undefined, document);
    const jumpToLatest = button('回到最新', 'agent-chat-jump-to-latest', document);
    jumpToLatest.hidden = true;
    jumpToLatest.setAttribute('aria-live', 'polite');
    const header = node('header', 'chat-header vcp-ui-scope agent-chat-header', undefined, document);
    const composer = node('footer', 'chat-input-area agent-chat-composer', undefined, document);
    const runStatus = node('div', 'agent-chat-run-status', undefined, document);
    runStatus.hidden = true;
    runStatus.setAttribute('role', 'status');
    runStatus.setAttribute('aria-live', 'polite');
    const runStatusIcon = node('span', 'vcp-ui-icon agent-chat-run-status-icon', 'progress_activity', document);
    const runStatusLabel = node('strong', 'agent-chat-run-status-label', '正在运行', document);
    const runStatusDetail = node('span', 'agent-chat-run-status-detail', undefined, document);
    const runStatusElapsed = node('time', 'agent-chat-run-status-elapsed', '0.0s', document);
    const runStatusStop = visualActionButton('stop', '停止当前任务', 'agent-chat-run-status-stop', '', document);
    runStatus.append(runStatusIcon, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop);

    const runningModes = node('div', 'agent-chat-composer-modes', undefined, document);
    runningModes.setAttribute('role', 'group');
    runningModes.setAttribute('aria-label', '运行中输入模式');
    const steerModeButton = button('立即调整', 'agent-chat-composer-mode', document);
    const followUpModeButton = button('排队后续', 'agent-chat-composer-mode', document);
    listen(steerModeButton, 'click', () => actions.setInputMode?.('steer'));
    listen(followUpModeButton, 'click', () => actions.setInputMode?.('follow-up'));
    runningModes.append(steerModeButton, followUpModeButton);
    const queuePanelHost = node('div', 'agent-chat-composer-queue', undefined, document);

    const inputCard = node('div', 'chat-input-card', undefined, document);
    const input = document.createElement('textarea');
    input.className = 'agent-chat-message-input';
    input.rows = 1;
    input.placeholder = '输入消息…（Shift + Enter 换行）';
    input.setAttribute('aria-label', '输入 Agent 消息');
    const composerActions = node('div', 'chat-input-actions', undefined, document);
    const newButton = visualActionButton('add_comment', '新建 Agent 会话', 'agent-chat-composer-new', '', document);
    const attachButton = visualActionButton('attach_file', '添加图片、音频或视频附件', '', '', document);
    const emoticonButton = visualActionButton('sentiment_satisfied', '打开表情包', '', '', document);
    const toolsButton = visualActionButton('construction', '选择 Agent 工具', 'agent-chat-composer-tools', '', document);
    const permissionsButton = visualActionButton('policy', '本地审批', 'agent-chat-composer-permissions', '', document);
    const sendButton = visualActionButton('arrow_upward', '发送消息', 'agent-chat-send-button', '', document);
    const attachmentTray = node('div', 'agent-chat-composer-attachments', undefined, document);
    listen(emoticonButton, 'click', () => actions.openEmoticons?.(emoticonButton, input));
    listen(toolsButton, 'click', () => actions.openToolSettings?.());
    listen(permissionsButton, 'click', () => actions.openPermissionSettings?.());
    composerActions.append(newButton, attachButton, emoticonButton, toolsButton, permissionsButton, sendButton);
    inputCard.append(attachmentTray, input, composerActions);
    // Runtime progress is presented in the header status chip. Keep the legacy
    // node available for controller compatibility, but do not show a second
    // status strip above the Composer.
    runStatus.hidden = true;
    composer.append(queuePanelHost, runningModes, inputCard);
    feed.append(feedItems);

    const mainColumn = node('div', 'agent-chat-main-column', undefined, document);
    const activityPanel = node('aside', 'agent-chat-activity-panel agent-chat-activity-collapsed', undefined, document);
    const activitySplitter = node('div', 'agent-chat-activity-splitter', undefined, document);
    activitySplitter.tabIndex = 0;
    activitySplitter.setAttribute('role', 'separator');
    activitySplitter.setAttribute('aria-orientation', 'vertical');
    activitySplitter.setAttribute('aria-label', '调整聊天区与会话信息面板宽度');
    activityPanel.id = 'agentChatActivityPanel';
    activityPanel.setAttribute('role', 'complementary');
    activityPanel.setAttribute('aria-label', 'Agent 活动面板');
    activityPanel.setAttribute('aria-hidden', 'true');
    activityPanel.setAttribute('inert', '');
    const activityInner = node('div', 'agent-chat-activity-inner', undefined, document);
    const activityClose = iconButton('close', '关闭会话信息面板', 'agent-chat-activity-close', document);
    listen(activityClose, 'click', () => actions.setActivityOpen?.(false));
    const activityTabs = node('div', 'agent-chat-activity-tabs', undefined, document);
    activityTabs.setAttribute('role', 'tablist');
    const activityTabTools = node('div', 'agent-chat-dock-tools', undefined, document);
    const activityAdd = iconButton('add', '打开会话工具', 'agent-chat-dock-add', document);
    activityAdd.setAttribute('aria-haspopup', 'menu');
    activityAdd.setAttribute('aria-expanded', 'false');
    activityTabTools.append(activityAdd, activityClose);
    const activityContent = node('div', 'agent-chat-activity-content', undefined, document);
    activityContent.setAttribute('role', 'presentation');
    const activityTabRow = node('div', 'agent-chat-dock-tab-row', undefined, document);
    activityTabRow.append(activityTabs, activityTabTools);
    activityInner.append(activityTabRow, activityContent);
    activityPanel.append(activityInner);

    const sidebarStep = 20;
    const sidebarMinWidth = 180;
    const sidebarMaxWidth = 600;
    const mainMinimumWidth = 320;
    let preferredSidebarWidth = Math.round(Math.max(sidebarMinWidth,
        Math.min(sidebarMaxWidth, state.agentSidebarWidth)) / sidebarStep) * sidebarStep;

    const getSidebarMaximumWidth = () => {
        const rootWidth = root.getBoundingClientRect().width;
        if (!Number.isFinite(rootWidth) || rootWidth <= 0) return sidebarMaxWidth;
        const splitterWidth = sidebarSplitter.getBoundingClientRect().width || 5;
        const activityReservedWidth = state.activityOpen
            ? Math.max(320, Math.min(760, Number(state.activityPanelWidth) || 320))
                + (activitySplitter.getBoundingClientRect().width || 7)
            : 0;
        const available = rootWidth - splitterWidth - mainMinimumWidth - activityReservedWidth;
        return Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth,
            Math.floor(available / sidebarStep) * sidebarStep));
    };

    const renderSidebarWidth = () => {
        const effectiveWidth = Math.max(sidebarMinWidth, Math.min(getSidebarMaximumWidth(), preferredSidebarWidth));
        [...sidebar.classList]
            .filter((name) => name.startsWith('agent-chat-sidebar-width-'))
            .forEach((name) => sidebar.classList.remove(name));
        sidebar.classList.add(`agent-chat-sidebar-width-${effectiveWidth}`);
        sidebarSplitter.setAttribute('aria-valuemin', String(sidebarMinWidth));
        sidebarSplitter.setAttribute('aria-valuemax', String(getSidebarMaximumWidth()));
        sidebarSplitter.setAttribute('aria-valuenow', String(effectiveWidth));
    };
    const applySidebarWidth = (width) => {
        preferredSidebarWidth = Math.round(Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, width)) / sidebarStep) * sidebarStep;
        state.agentSidebarWidth = preferredSidebarWidth;
        renderSidebarWidth();
    };
    const persistSidebarWidth = () => {
        try { window.localStorage?.setItem('vcpchat.agentWorkbench.sidebarWidth', String(preferredSidebarWidth)); } catch { /* storage is optional */ }
    };
    applySidebarWidth(preferredSidebarWidth);
    const sidebarResizer = window.VCPSidebarResizer?.create({
        handle: sidebarSplitter,
        document,
        eventNames: { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' },
        getValue: () => preferredSidebarWidth,
        getBounds: () => ({ min: sidebarMinWidth, max: getSidebarMaximumWidth() }),
        applyValue: applySidebarWidth,
        step: sidebarStep,
        onCommit: persistSidebarWidth,
        onActiveChange: (active) => {
            sidebar.classList.toggle('agent-chat-sidebar-resizing', active);
            document.body.classList.toggle('vcp-sidebar-resizing', active);
        },
    });
    const sidebarResizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => renderSidebarWidth());
    sidebarResizeObserver?.observe(root);
    let dragCleanup = null;
    const applyActivityPanelWidth = (width) => {
        state.activityPanelWidth = Math.round(Math.max(320, Math.min(760, width)) / 20) * 20;
        [...activityPanel.classList]
            .filter((name) => name.startsWith('agent-chat-activity-width-'))
            .forEach((name) => activityPanel.classList.remove(name));
        activityPanel.classList.add(`agent-chat-activity-width-${state.activityPanelWidth}`);
        activitySplitter.setAttribute('aria-valuenow', String(state.activityPanelWidth));
    };
    applyActivityPanelWidth(state.activityPanelWidth);
    listen(activitySplitter, 'pointerdown', (event) => {
        event.preventDefault();
        dragCleanup?.();
        activitySplitter.setPointerCapture?.(event.pointerId);
        const bounds = main.getBoundingClientRect();
        const onMove = (moveEvent) => applyActivityPanelWidth(bounds.right - moveEvent.clientX);
        const onUp = (upEvent) => {
            activitySplitter.releasePointerCapture?.(upEvent.pointerId);
            dragCleanup?.();
        };
        dragCleanup = () => {
            activitySplitter.removeEventListener('pointermove', onMove);
            activitySplitter.removeEventListener('pointerup', onUp);
            activitySplitter.removeEventListener('pointercancel', onUp);
            dragCleanup = null;
        };
        activitySplitter.addEventListener('pointermove', onMove);
        activitySplitter.addEventListener('pointerup', onUp);
        activitySplitter.addEventListener('pointercancel', onUp);
    });
    listen(activitySplitter, 'keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        applyActivityPanelWidth(state.activityPanelWidth + (event.key === 'ArrowLeft' ? 20 : -20));
    });

    mainColumn.append(header, feed, jumpToLatest, composer);
    main.append(mainColumn, activitySplitter, activityPanel);
    root.append(sidebar, sidebarSplitter, main);
    container.classList.add('agent-workbench-root', 'agent-chat-root');
    container.append(root, topicFlowLayer);

    const refs = {
        root, topicFlowLayer, sidebar, sidebarSplitter, main, feed, feedItems, jumpToLatest, header, composer,
        runStatus, runStatusIcon, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop,
        runningModes, steerModeButton, followUpModeButton, queuePanelHost, inputCard, input,
        newButton, attachButton, emoticonButton, toolsButton, permissionsButton, sendButton, attachmentTray,
        activityPanel, activitySplitter, activityClose, activityTabs, activityAdd, activityContent,
        refreshSidebarWidth: renderSidebarWidth,
        activityTabRow,
    };
    return {
        element: root,
        refs,
        update(model = {}) {
            if (Number.isFinite(model.activityPanelWidth)) applyActivityPanelWidth(model.activityPanelWidth);
        },
        dispose() {
            dragCleanup?.();
            sidebarResizer?.dispose();
            sidebarResizeObserver?.disconnect();
            for (const dispose of disposers.splice(0).reverse()) dispose();
            root.remove();
            topicFlowLayer.remove();
        },
    };
}

export { createAgentWorkbenchShellView };
