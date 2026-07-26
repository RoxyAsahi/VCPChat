import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import {
    projectArtifact,
    projectMessage,
    projectPlan,
    projectSession,
    projectTool,
} from './agent-workbench-projections.js';

const api = () => window.chatAPI || window.electronAPI || {};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(text, className = 'agent-wb-btn') {
    const variant = className.includes('danger') || className.includes('deny') ? 'danger'
        : className.includes('ghost') ? 'ghost'
            : className.includes('secondary') ? 'secondary'
                : className.includes('primary') || className === 'agent-wb-btn' ? 'primary' : 'ghost';
    const size = className.includes('small') ? 'sm' : 'md';
    const iconByLabel = {
        '启动 Runtime': 'play_arrow',
        '停止': 'stop',
        '创建会话': 'add',
        '取消': 'close',
        '发送': 'arrow_upward',
        '重命名': 'edit',
        '分支': 'call_split',
        '压缩': 'compress',
        '允许一次': 'check',
        '拒绝': 'close',
    };
    const controller = window.VCPUI?.create?.('Button', {
        label: text,
        variant,
        size,
        icon: iconByLabel[text],
        block: className.includes('block'),
    });
    const node = controller?.element || el('button', '', text);
    if (!controller) node.type = 'button';
    node.classList.add(...className.split(/\s+/).filter(Boolean));
    if (controller) node._vcpController = controller;
    return node;
}

function iconButton(text, label, className = 'agent-wb-icon-btn') {
    const iconNames = { '+': 'add', '×': 'close', '◫': 'side_navigation' };
    const variant = className.includes('danger') ? 'danger' : className.includes('primary') ? 'secondary' : 'ghost';
    const controller = window.VCPUI?.create?.('IconButton', {
        icon: iconNames[text] || text,
        label,
        title: label,
        variant,
        size: 'md',
    });
    const node = controller?.element || button(text, className);
    node.classList.add(...className.split(/\s+/).filter(Boolean));
    if (controller) node._vcpController = controller;
    node.setAttribute('aria-label', label);
    node.title = label;
    return node;
}

function formatTime(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString();
    } catch (error) {
        return '';
    }
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
}

function createMainChatComposer() {
    const source = document.getElementById('messageInput')?.closest('.chat-input-area');
    const composer = source?.cloneNode(true) || el('footer', 'chat-input-area vcp-ui-scope');
    if (!source) {
        const card = el('div', 'chat-input-card');
        const preview = el('div', 'attachment-preview-area');
        const input = el('textarea', 'chat-message-input');
        const actions = el('div', 'chat-input-actions');
        const action = (iconName, label) => {
            const node = el('button');
            node.type = 'button';
            node.title = label;
            node.setAttribute('aria-label', label);
            node.append(el('span', 'material-symbols-outlined vcp-ui-icon', iconName));
            return node;
        };
        actions.append(action('add_comment', '新建会话'), action('attach_file', '发送文件'), action('sentiment_satisfied', '打开表情包'), action('arrow_upward', '发送消息'));
        card.append(preview, input, actions);
        composer.append(card);
    }

    const originalIds = ['messageInput', 'quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn', 'sendMessageBtn', 'attachmentPreviewArea'];
    const parts = Object.fromEntries(originalIds.map(id => [id, composer.querySelector(`#${id}`)]));
    const fallbackActions = [...composer.querySelectorAll('.chat-input-actions > button')];
    const input = parts.messageInput || composer.querySelector('textarea');
    const quickNew = parts.quickNewTopicBtn || fallbackActions[0];
    const attach = parts.attachFileBtn || fallbackActions[1];
    const emoticon = parts.emoticonTriggerBtn || fallbackActions[2];
    const send = parts.sendMessageBtn || fallbackActions[3];
    const preview = parts.attachmentPreviewArea || composer.querySelector('.attachment-preview-area');
    composer.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    composer.classList.add('agent-wb-composer');
    composer.querySelector('.chat-input-card')?.classList.add('agent-wb-composer-card');
    input.classList.add('chat-message-input', 'agent-wb-prompt');
    input.disabled = false;
    input.placeholder = '输入消息... (Shift+Enter 换行)';
    input.setAttribute('aria-label', '输入 Agent 消息');
    quickNew?.classList.add('chat-quick-new-button', 'agent-wb-quick-new');
    attach?.classList.add('chat-attach-button');
    emoticon?.classList.add('chat-emoticon-button');
    send?.classList.add('chat-send-button', 'agent-wb-send-btn');
    if (quickNew) {
        quickNew.disabled = false;
        quickNew.title = '新建 Agent 会话';
        quickNew.setAttribute('aria-label', '新建 Agent 会话');
    }
    if (attach) {
        attach.disabled = true;
        attach.title = 'Agent 附件将在接入主聊天附件能力后可用';
    }
    if (emoticon) {
        emoticon.disabled = true;
        emoticon.title = 'Agent 暂不支持表情包';
    }
    if (send) send.disabled = true;
    return { composer, input, quickNew, attach, emoticon, send, preview };
}

function mountWorkbench(container) {
    const controller = createWorkbenchController(api());
    const { store } = controller;
    const ui = window.VCPUI;
    let disposed = false;

    container.classList.add('agent-workbench-root', 'agent-chat-root');

    const errorBar = el('div', 'agent-wb-notice');
    errorBar.hidden = true;

    const columns = el('div', 'agent-wb-columns agent-chat-shell is-context-hidden');
    const sessionsColumn = el('aside', 'sidebar active vcp-ui-scope agent-wb-column agent-wb-sessions');
    const conversationColumn = el('main', 'main-content agent-wb-column agent-wb-conversation');
    const contextColumn = el('aside', 'agent-wb-column agent-wb-context');
    columns.append(sessionsColumn, conversationColumn, contextColumn);

    const sidebarTabsController = ui?.create?.('Tabs', {
        value: 'agent',
        items: [
            { label: '智能体', value: 'agent' },
            { label: '会话', value: 'sessions' },
        ],
    });
    const sidebarTabs = sidebarTabsController?.element || el('div', 'sidebar-tabs');
    sidebarTabs.classList.add('sidebar-tabs', 'agent-wb-tabs');
    if (!sidebarTabsController) {
        sidebarTabs.append(
            button('智能体', 'sidebar-tab-button active'),
            button('会话', 'sidebar-tab-button'),
        );
    }
    const sessionsHeader = el('div', 'agent-wb-column-header');
    const newSessionBtn = button('智能体', 'agent-wb-add-agent agent-wb-btn agent-wb-btn-ghost');
    newSessionBtn.prepend(el('span', 'material-symbols-outlined vcp-ui-icon', 'add'));
    newSessionBtn.setAttribute('aria-label', '新建智能体会话');
    sessionsHeader.append(newSessionBtn);
    const sessionForm = el('div', 'agent-wb-session-form');
    sessionForm.hidden = true;
    const workspaceInput = el('input', 'agent-wb-input');
    workspaceInput.placeholder = 'Workspace 根目录（可选）';
    workspaceInput.setAttribute('aria-label', 'Workspace 根目录');
    const modelInput = el('input', 'agent-wb-input');
    modelInput.placeholder = '模型 ID';
    modelInput.setAttribute('aria-label', '模型 ID');
    ui?.enhance?.('Input', workspaceInput, { size: 'md', label: 'Workspace 根目录' });
    ui?.enhance?.('Input', modelInput, { size: 'md', label: '模型 ID' });
    const sessionFormActions = el('div', 'agent-wb-session-form-actions');
    const createSessionBtn = button('创建会话', 'agent-wb-btn agent-wb-btn-primary agent-wb-btn-block');
    const cancelCreateBtn = button('取消', 'agent-wb-btn agent-wb-btn-ghost agent-wb-btn-block');
    sessionFormActions.append(cancelCreateBtn, createSessionBtn);
    sessionForm.append(workspaceInput, modelInput, sessionFormActions);
    const sessionListController = ui?.create?.('List', { items: [] });
    const sessionList = sessionListController?.element || el('div', 'agent-wb-session-list');
    sessionList.classList.add('agent-wb-session-list');
    sessionsColumn.append(sidebarTabs, sessionsHeader, sessionForm, sessionList);

    const conversationHeader = el('header', 'chat-header vcp-ui-scope agent-wb-column-header agent-wb-conversation-header');
    const collapseSidebarBtn = iconButton('left_panel_close', '收起智能体侧栏');
    const conversationIdentity = el('nav', 'agent-wb-breadcrumb');
    const agentAvatar = el('span', 'agent-wb-agent-avatar material-symbols-outlined', 'smart_toy');
    const breadcrumbAgent = el('span', 'agent-wb-breadcrumb-item', 'VCP Agent');
    const breadcrumbSession = el('strong', 'agent-wb-breadcrumb-item', '选择一个会话');
    const breadcrumbModel = el('span', 'agent-wb-breadcrumb-item agent-wb-muted');
    const breadcrumbWorkspace = el('span', 'agent-wb-breadcrumb-item agent-wb-muted');
    const separatorSession = el('span', 'agent-wb-breadcrumb-separator', '›');
    const separatorModel = el('span', 'agent-wb-breadcrumb-separator', '›');
    const separatorWorkspace = el('span', 'agent-wb-breadcrumb-separator', '›');
    conversationIdentity.append(agentAvatar, breadcrumbAgent, separatorSession, breadcrumbSession, separatorModel, breadcrumbModel, separatorWorkspace, breadcrumbWorkspace);
    const renameBtn = button('重命名', 'agent-wb-btn agent-wb-btn-small agent-wb-btn-ghost');
    const forkBtn = button('分支', 'agent-wb-btn agent-wb-btn-small agent-wb-btn-ghost');
    const compactBtn = button('压缩', 'agent-wb-btn agent-wb-btn-small agent-wb-btn-ghost');
    const contextToggleBtn = iconButton('tune', '显示或隐藏任务面板');
    const terminalHeaderBtn = iconButton('terminal', '打开 VCPCLI 终端');
    const deleteBtn = iconButton('×', '删除当前会话', 'agent-wb-icon-btn agent-wb-icon-btn-danger');
    const moreBtn = iconButton('more_vert', '更多会话操作');
    const sessionActionsController = ui?.create?.('Toolbar', {
        label: '会话操作',
        start: [],
        end: [terminalHeaderBtn, contextToggleBtn, moreBtn],
    });
    const sessionActions = sessionActionsController?.element || el('div', 'chat-actions agent-wb-actions');
    sessionActions.classList.add('chat-actions', 'agent-wb-actions');
    if (!sessionActionsController) sessionActions.append(terminalHeaderBtn, contextToggleBtn, moreBtn);
    const actionMenu = el('div', 'agent-wb-action-menu');
    actionMenu.hidden = true;
    actionMenu.append(renameBtn, forkBtn, compactBtn, deleteBtn);
    sessionActions.append(actionMenu);
    const conversationHeaderLeft = el('div', 'agent-wb-conversation-header-left');
    conversationHeaderLeft.append(collapseSidebarBtn, conversationIdentity);
    conversationHeader.append(conversationHeaderLeft, sessionActions);

    const feedContainer = el('div', 'chat-messages-container vcp-ui-scope agent-wb-feed-container');
    const feed = el('div', 'chat-messages agent-wb-feed');
    feed.setAttribute('aria-live', 'polite');
    feedContainer.append(feed);
    const reusedComposer = createMainChatComposer();
    const { composer, input: promptInput, quickNew: composerNewSessionBtn, send: sendBtn } = reusedComposer;
    const composerActionRow = composer.querySelector('.chat-input-actions');
    const approvalToolBtn = iconButton('shield', '安全与审批', 'chat-input-tool-button');
    const terminalToolBtn = iconButton('terminal', '打开 VCPCLI 终端', 'chat-input-tool-button');
    const planToolBtn = iconButton('bolt', '任务计划与执行状态', 'chat-input-tool-button');
    const focusToolBtn = iconButton('fullscreen', '专注模式', 'chat-input-tool-button');
    const workspaceToolBtn = iconButton('folder_open', '工作区', 'chat-input-tool-button');
    if (composerActionRow) {
        reusedComposer.attach?.before(approvalToolBtn, terminalToolBtn);
        composerActionRow.insertBefore(planToolBtn, sendBtn);
        composerActionRow.insertBefore(focusToolBtn, sendBtn);
        composerActionRow.insertBefore(workspaceToolBtn, sendBtn);
    }
    conversationColumn.append(conversationHeader, feedContainer, composer);

    const contextHeader = el('div', 'agent-wb-column-header');
    const contextIdentity = el('div');
    contextIdentity.append(
        el('h2', 'agent-wb-column-title', '任务面板'),
        el('div', 'agent-wb-muted', '上下文与执行状态'),
    );
    const closeContextBtn = iconButton('×', '关闭任务面板');
    contextHeader.append(contextIdentity, closeContextBtn);
    const contextBody = el('div', 'agent-wb-context-body');
    function panel(title, description = '') {
        const card = ui?.create?.('Card', { title, description, variant: 'outlined' })?.element
            || el('section', 'agent-wb-panel');
        card.classList.add('agent-wb-panel');
        if (!ui && title) card.append(el('h3', 'agent-wb-section-title', title));
        return card;
    }

    const usageSection = panel('上下文用量');
    const usageText = el('div', 'agent-wb-context-usage', '0 / 0 tokens');
    const usageTrack = el('progress', 'agent-wb-progress');
    usageTrack.max = 100;
    usageTrack.value = 0;
    usageTrack.setAttribute('aria-label', 'Context usage');
    const summaryText = el('div', 'agent-wb-summary agent-wb-muted', '暂无压缩摘要');
    usageSection.append(usageText, usageTrack, summaryText);

    const approvalsSection = panel('待确认操作');
    const approvalsList = el('div', 'agent-wb-stack');
    approvalsSection.append(approvalsList);

    const planSection = panel('任务计划');
    const planList = el('div', 'agent-wb-stack');
    planSection.append(planList);

    const artifactsSection = panel('文件与产物');
    const artifactsList = el('div', 'agent-wb-stack');
    artifactsSection.append(artifactsList);
    contextBody.append(usageSection, approvalsSection, planSection, artifactsSection);
    contextColumn.append(contextHeader, contextBody);

    container.append(errorBar, columns);

    function showError(error) {
        errorBar.hidden = false;
        errorBar.textContent = error?.message || String(error);
    }

    function run(action) {
        errorBar.hidden = true;
        Promise.resolve().then(action).catch(showError);
    }

    function getActiveSession(state = store.getState()) {
        return state.sessions.find((session) => session.sessionId === state.activeSessionId) || null;
    }

    function renderSessions(state) {
        if (sessionListController) {
            const sessions = state.sessions.map(raw => {
                const session = projectSession(raw);
                return {
                    label: session.title,
                    description: [session.model, session.workspaceRoot].filter(Boolean).join(' · '),
                    trailing: session.state,
                    icon: 'smart_toy',
                    selected: session.sessionId === state.activeSessionId,
                    onClick: () => run(() => controller.selectSession(session.sessionId)),
                };
            });
            if (!sessions.length) sessions.push({
                label: 'VCP Agent',
                description: '点击创建第一个会话',
                icon: 'smart_toy',
                selected: true,
                onClick: () => setSessionFormOpen(true),
            });
            sessionListController.update({ items: sessions });
            sessionList.querySelectorAll('.vcp-ui-list-item').forEach((item, index) => {
                item.classList.add('agent-wb-session');
                item.dataset.sessionId = state.sessions[index]?.sessionId || '';
                item.classList.toggle('is-active', item.dataset.state === 'selected');
            });
            return;
        }
        sessionList.replaceChildren();
        if (!state.sessions.length) {
            sessionList.append(el('div', 'agent-wb-empty', '暂无会话。点击 + 新建一个 Agent 会话。'));
            return;
        }
        for (const raw of state.sessions) {
            const session = projectSession(raw);
            const item = button('', `agent-wb-session${session.sessionId === state.activeSessionId ? ' is-active' : ''}`);
            item.dataset.sessionId = session.sessionId;
            item.setAttribute('aria-pressed', String(session.sessionId === state.activeSessionId));
            const top = el('span', 'agent-wb-session-top');
            top.append(el('strong', 'agent-wb-session-title', session.title), el('span', `agent-wb-state agent-wb-state-${session.state}`, session.state));
            item.append(top, el('span', 'agent-wb-session-model', session.model));
            const details = [session.workspaceRoot, formatTime(session.updatedAt)].filter(Boolean).join(' · ');
            if (details) item.append(el('span', 'agent-wb-session-detail', details));
            item.addEventListener('click', () => run(() => controller.selectSession(session.sessionId)));
            sessionList.append(item);
        }
    }

    function renderFeed(state) {
        feed.replaceChildren();
        const entries = [];
        state.messages.map(projectMessage).forEach((message) => entries.push({ type: 'message', time: message.createdAt, value: message }));
        Array.from(state.tools.values()).map(projectTool).forEach((tool) => entries.push({ type: 'tool', time: tool.events?.[0]?.timestamp || 0, value: tool }));
        if (!entries.length) {
            return;
        }
        entries.sort((left, right) => (left.time || 0) - (right.time || 0));
        for (const entry of entries) {
            if (entry.type === 'tool') {
                const tool = entry.value;
                const card = el('article', `agent-wb-tool agent-wb-tool-${tool.state}`);
                const top = el('div', 'agent-wb-tool-header');
                top.append(el('strong', '', tool.name), el('span', 'agent-wb-tool-state', tool.state));
                card.append(top);
                if (tool.summary) card.append(el('pre', 'agent-wb-tool-summary', tool.summary));
                feed.append(card);
                continue;
            }
            const message = entry.value;
            const card = el('article', `message-item agent-wb-message agent-wb-message-${message.role} ${message.role}`);
            const messageHeader = el('div', 'agent-wb-message-header');
                const roleLabel = message.role === 'user' ? '你' : message.role === 'assistant' ? 'Agent' : message.role;
                messageHeader.append(el('strong', '', roleLabel), el('span', 'agent-wb-muted', message.state));
            const bubbleWrap = el('div', 'details-and-bubble-wrapper');
            bubbleWrap.append(messageHeader);
            if (message.reasoning) {
                const reasoning = document.createElement('details');
                reasoning.className = 'agent-wb-reasoning';
                const reasoningTitle = el('summary', '', 'Reasoning');
                reasoning.append(reasoningTitle, el('pre', '', message.reasoning));
                bubbleWrap.append(reasoning);
            }
            bubbleWrap.append(el('div', 'md-content agent-wb-message-content', message.content || (message.state === 'streaming' ? '…' : '')));
            card.append(bubbleWrap);
            feed.append(card);
        }
        feed.scrollTop = feed.scrollHeight;
    }

    function renderApprovals(state) {
        approvalsList.replaceChildren();
        if (!state.approvals.length) {
            approvalsList.append(el('div', 'agent-wb-muted', '无待审批请求'));
            return;
        }
        for (const approval of state.approvals) {
            const cardController = ui?.create?.('Card', {
                title: approval.toolName || 'tool',
                description: [approval.riskLevel, approval.reason].filter(Boolean).join(' · '),
                variant: 'outlined',
            });
            const card = cardController?.element || el('div', 'agent-wb-approval-card');
            card.classList.add('agent-wb-approval-card');
            if (!cardController) card.append(
                el('strong', '', `${approval.toolName || 'tool'} · ${approval.riskLevel || 'unknown'}`),
                el('div', 'agent-wb-muted', approval.reason || ''),
            );
            if (approval.argumentSummary) card.append(el('pre', 'agent-wb-tool-summary', approval.argumentSummary));
            const actions = el('div', 'agent-wb-actions');
            const allow = button('允许一次', 'agent-wb-btn agent-wb-btn-small agent-wb-btn-allow');
            const deny = button('拒绝', 'agent-wb-btn agent-wb-btn-small agent-wb-btn-deny');
            allow.addEventListener('click', () => run(() => controller.respondApproval(approval, 'allow')));
            deny.addEventListener('click', () => run(() => controller.respondApproval(approval, 'deny')));
            actions.append(allow, deny);
            card.append(actions);
            approvalsList.append(card);
        }
    }

    function renderPlan(state) {
        planList.replaceChildren();
        const plan = projectPlan(state.plan);
        if (plan.raw) {
            planList.append(el('pre', 'agent-wb-plan-raw', plan.raw));
        } else if (!plan.steps.length) {
            planList.append(el('div', 'agent-wb-muted', '暂无 Plan'));
        } else if (ui) {
            const list = ui.create('List', { items: plan.steps.map(step => ({
                label: step.text,
                trailing: step.status,
                icon: step.status === 'completed' ? 'check_circle' : step.status === 'in_progress' ? 'progress_activity' : 'radio_button_unchecked',
                interactive: false,
            })) });
            list.element.classList.add('agent-wb-plan-list');
            planList.append(list.element);
        } else {
            for (const step of plan.steps) {
                const row = el('div', `agent-wb-plan-step agent-wb-plan-step-${step.status}`);
                row.append(el('span', 'agent-wb-plan-dot'), el('span', '', step.text));
                planList.append(row);
            }
        }
    }

    function renderArtifacts(state) {
        artifactsList.replaceChildren();
        const artifacts = state.artifacts.map(projectArtifact);
        if (!artifacts.length) {
            artifactsList.append(el('div', 'agent-wb-muted', '暂无文件或任务产物'));
            return;
        }
        if (ui) {
            const list = ui.create('List', { items: artifacts.map(artifact => ({
                label: artifact.label,
                trailing: artifact.kind,
                icon: 'description',
                interactive: false,
            })) });
            list.element.classList.add('agent-wb-artifact-list');
            artifactsList.append(list.element);
            return;
        }
        for (const artifact of artifacts) {
            const card = el('div', 'agent-wb-artifact');
            card.append(el('strong', '', artifact.label), el('span', 'agent-wb-muted', artifact.kind));
            artifactsList.append(card);
        }
    }

    function render(state) {
        if (state.notice) showError(state.notice.text);

        renderSessions(state);
        const active = getActiveSession(state);
        const session = active ? projectSession(active) : null;
        breadcrumbSession.textContent = session?.title || '新会话';
        breadcrumbModel.textContent = session?.model || '默认模型';
        breadcrumbWorkspace.textContent = session?.workspaceRoot || '选择工作区';
        renderFeed(state);

        usageText.textContent = `${formatNumber(state.context.usedTokens)} / ${formatNumber(state.context.contextWindow)} tokens (${state.context.percentage}%)`;
        usageTrack.value = state.context.percentage;
        usageTrack.classList.toggle('is-warning', state.context.percentage >= 80);
        summaryText.textContent = state.context.compacting ? '正在压缩 Context…' : state.context.summary || '暂无压缩摘要';
        renderApprovals(state);
        renderPlan(state);
        renderArtifacts(state);

        const hasSession = Boolean(state.activeSessionId);
        const turnRunning = Boolean(state.activeTurnId);
        [renameBtn, forkBtn, compactBtn, deleteBtn, sendBtn].filter(Boolean).forEach((node) => { node.disabled = !hasSession; });
        sendBtn.disabled = !hasSession || turnRunning;
    }

    function setSessionFormOpen(open) {
        sessionForm.hidden = !open;
        newSessionBtn.classList.toggle('is-active', open);
        if (open) workspaceInput.focus();
    }
    newSessionBtn.addEventListener('click', () => setSessionFormOpen(sessionForm.hidden));
    composerNewSessionBtn?.addEventListener('click', () => setSessionFormOpen(true));
    cancelCreateBtn.addEventListener('click', () => setSessionFormOpen(false));
    createSessionBtn.addEventListener('click', () => run(async () => {
        await controller.createSession({
            workspaceRoot: workspaceInput.value.trim() || undefined,
            model: modelInput.value.trim() || undefined,
        });
        setSessionFormOpen(false);
    }));
    function setContextOpen(open) {
        columns.classList.toggle('is-context-hidden', !open);
        contextToggleBtn.classList.toggle('is-active', open);
    }
    contextToggleBtn.addEventListener('click', () => setContextOpen(columns.classList.contains('is-context-hidden')));
    closeContextBtn.addEventListener('click', () => setContextOpen(false));
    collapseSidebarBtn.addEventListener('click', () => columns.classList.toggle('is-sidebar-collapsed'));
    const openTerminal = () => run(() => api().desktopLaunchVchatApp?.('open-powershell-executor-terminal'));
    terminalHeaderBtn.addEventListener('click', openTerminal);
    terminalToolBtn.addEventListener('click', openTerminal);
    approvalToolBtn.addEventListener('click', () => setContextOpen(true));
    planToolBtn.addEventListener('click', () => setContextOpen(true));
    workspaceToolBtn.addEventListener('click', () => setSessionFormOpen(true));
    focusToolBtn.addEventListener('click', () => columns.classList.toggle('is-focus-mode'));
    moreBtn.addEventListener('click', () => { actionMenu.hidden = !actionMenu.hidden; });
    renameBtn.addEventListener('click', () => {
        const session = getActiveSession();
        if (!session) return;
        const title = window.prompt('Session 名称', projectSession(session).title);
        if (title?.trim()) run(() => controller.renameSession(session.sessionId, title.trim()));
    });
    forkBtn.addEventListener('click', () => {
        const sessionId = store.getState().activeSessionId;
        if (sessionId) run(() => controller.forkSession(sessionId));
    });
    compactBtn.addEventListener('click', () => {
        const sessionId = store.getState().activeSessionId;
        if (sessionId) run(() => controller.compactSession(sessionId));
    });
    deleteBtn.addEventListener('click', () => {
        const sessionId = store.getState().activeSessionId;
        if (sessionId && window.confirm('确认删除当前 Session？')) run(() => controller.deleteSession(sessionId));
    });

    function submitPrompt() {
        const prompt = promptInput.value.trim();
        if (!prompt) return;
        run(async () => {
            await controller.startTurn(prompt);
            promptInput.value = '';
            window.uiHelperFunctions?.autoResizeTextarea?.(promptInput);
        });
    }
    sendBtn.addEventListener('click', submitPrompt);
    promptInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitPrompt();
        }
    });
    promptInput.addEventListener('input', () => window.uiHelperFunctions?.autoResizeTextarea?.(promptInput));

    const unsubscribeStore = store.subscribe(render);
    render(store.getState());
    controller.initialize()
        .then(() => {
            const state = store.getState();
            if (state.runtime.state === 'stopped' || state.runtime.state === 'unknown') return controller.startRuntime();
            return null;
        })
        .catch(showError);

    return () => {
        if (disposed) return;
        disposed = true;
        unsubscribeStore();
        controller.dispose();
        container.replaceChildren();
        container.classList.remove('agent-workbench-root', 'agent-chat-root');
    };
}

register({
    id: 'agent-workbench',
    title: 'Agent',
    icon: 'smart_toy',
    kind: 'internal',
    mount: mountWorkbench,
});
