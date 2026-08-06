import {
    button,
    createSidebarSearchPanel,
    icon,
    node,
    visualActionButton,
} from './agent-workbench-dom.js';

function normalized(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function activateOnKeyboard(element, action) {
    element.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        action(event);
    });
}

export function createAgentWorkbenchSidebarView({
    element,
    accountView,
    lifecycle,
    actions,
}) {
    let model = null;
    let sessionShell = null;
    let searchRequest = 0;

    function invalidateSessionShell() {
        sessionShell = null;
    }

    function patchSessionRows() {
        if (!sessionShell || model.tab !== 'sessions' || model.topicManaging
            || model.topicSearchOpen || model.topicSearch.trim()
            || sessionShell.agentId !== model.selectedAgent) return false;
        const desired = [
            ...model.liveSessions.map((session) => ({ id: session.sessionId, live: true, value: session })),
            ...model.persistedTopics.map((topic) => ({ id: topic.id, live: false, value: topic })),
        ];
        const rows = [...sessionShell.list.children]
            .filter((row) => row.classList.contains('agent-chat-session-row'));
        if (rows.length !== desired.length
            || rows.some((row, index) => row.dataset.sessionId !== desired[index].id)) return false;

        for (const [index, entry] of desired.entries()) {
            const row = rows[index];
            const active = entry.id === model.selectedSessionId;
            const activity = entry.value.activity || 'idle';
            row.classList.toggle('active', active);
            row.classList.toggle('active-topic-glowing', active);
            row.classList.toggle('is-running', ['starting', 'running'].includes(activity));
            row.classList.toggle('is-awaiting-approval', activity === 'awaiting-approval');
            row.dataset.runtimeActivity = activity;
            const avatar = row.querySelector('.agent-chat-session-avatar');
            if (avatar) {
                avatar.dataset.activity = activity;
                avatar.classList.toggle('is-running', ['starting', 'running'].includes(activity));
                avatar.classList.toggle('is-awaiting-approval', activity === 'awaiting-approval');
            }
            row.dataset.topicSearch = `${entry.value.title || entry.id} ${entry.value.model || ''}`.toLocaleLowerCase();
            const title = row.querySelector('.topic-title-display');
            if (title) title.textContent = entry.value.title || entry.id;
            if (entry.live) {
                const count = row.querySelector('.message-count');
                if (count) count.textContent = active
                    ? String(model.selectedMessageCount)
                    : activity === 'awaiting-approval' ? '!' : '';
            } else {
                row.title = entry.value.searchHit?.snippet || '';
            }
        }
        return true;
    }

    function renderTabs() {
        const tabs = node('div', 'sidebar-tabs');
        for (const [id, label] of [['agents', '助手'], ['sessions', '会话'], ['settings', '设置']]) {
            const tab = node('button', `sidebar-tab-button${model.tab === id ? ' active' : ''}`, label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(model.tab === id));
            tab.addEventListener('click', () => actions.selectTab(id));
            tabs.append(tab);
        }
        return tabs;
    }

    function createSessionRow(session) {
        const active = session.sessionId === model.selectedSessionId;
        const activity = session.activity || 'idle';
        const row = node('li', `topic-item agent-chat-session-row${active ? ' active active-topic-glowing' : ''}${['starting', 'running'].includes(activity) ? ' is-running' : ''}${activity === 'awaiting-approval' ? ' is-awaiting-approval' : ''}`);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.dataset.itemId = session.agentId;
        row.dataset.itemType = 'agent-runtime';
        row.dataset.sessionId = session.sessionId;
        row.dataset.topicInUse = 'false';
        row.dataset.runtimeActivity = activity;
        row.dataset.topicSearch = `${session.title} ${session.model}`.toLocaleLowerCase();
        const avatar = actions.createSessionAvatar(session.sessionId, session.agentId,
            `${session.agentId} - ${session.title}`, activity);
        const title = node('span', 'topic-title-display', session.title);
        const count = node('span', 'message-count', active
            ? String(model.selectedMessageCount)
            : activity === 'awaiting-approval' ? '!' : '');
        row.append(avatar, title, count);
        row.addEventListener('click', () => actions.hydrateSession(session));
        activateOnKeyboard(row, () => actions.hydrateSession(session));
        if (!model.topicManaging && session.sessionId) {
            actions.appendSessionActions(row, {
                id: session.sessionId,
                title: session.title,
                agentId: session.agentId,
                model: session.model,
                workspaceRef: session.workspaceRoot,
                inUse: false,
            }, { live: true });
        }
        return row;
    }

    function createPersistedRow(topic) {
        const selected = model.topicSelectedIds.has(topic.id);
        const active = topic.id === model.selectedSessionId;
        const row = node('li', `topic-item agent-chat-session-row agent-chat-persisted-topic${selected ? ' selected' : ''}${active ? ' active active-topic-glowing' : ''}`);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.dataset.itemId = topic.agentId;
        row.dataset.itemType = 'agent-topic';
        row.dataset.sessionId = topic.id;
        row.dataset.topicSearch = `${topic.title || topic.id} ${topic.model || ''}`.toLocaleLowerCase();
        const avatar = actions.createSessionAvatar(topic.id, topic.agentId,
            `${topic.agentId} - ${topic.title || topic.id}`);
        const title = node('span', 'topic-title-display', topic.title || topic.id);
        const status = topic.searchHit ? node('span', 'message-count', '匹配') : null;
        if (topic.searchHit?.snippet) row.title = topic.searchHit.snippet;
        row.append(avatar, title);
        if (status) row.append(status);
        const selectIcon = node('span', 'vcp-ui-icon next-ui-topic-select-icon', selected ? 'check_box' : 'check_box_outline_blank');
        selectIcon.setAttribute('aria-hidden', 'true');
        row.prepend(selectIcon);
        row.setAttribute('aria-selected', String(selected));
        row.addEventListener('click', (event) => {
            if (event.target.closest('.agent-chat-session-menu')) return;
            if (model.topicManaging) actions.toggleTopicSelection(topic.id);
            else actions.previewSession(topic);
        });
        activateOnKeyboard(row, (event) => {
            if (model.topicManaging) actions.toggleTopicSelection(topic.id);
            else actions.previewSession(topic);
        });
        if (!model.topicManaging) actions.appendSessionActions(row, topic);
        return row;
    }

    function renderSessionManagement(content, list, persistedTopics) {
        if (!model.topicManaging) return;
        content.classList.add('is-managing');
        const panel = node('div', 'next-ui-topic-manage-panel agent-chat-topic-manage-panel');
        panel.setAttribute('aria-hidden', 'false');
        const selection = node('div', 'next-ui-topic-manage-selection');
        const visibleIds = [...list.querySelectorAll('.agent-chat-persisted-topic[data-session-id]')]
            .filter((row) => !row.hidden && !model.topics.find((topic) => topic.id === row.dataset.sessionId)?.inUse)
            .map((row) => row.dataset.sessionId);
        const allSelected = visibleIds.length > 0
            && visibleIds.every((sessionId) => model.topicSelectedIds.has(sessionId));
        const selectAll = button('', 'next-ui-topic-manage-button');
        selectAll.title = '全选可归档会话';
        selectAll.setAttribute('aria-label', '全选可归档会话');
        selectAll.append(...icon(allSelected ? 'check_box' : 'check_box_outline_blank'));
        selectAll.addEventListener('click', () => actions.selectVisibleSessions(visibleIds, !allSelected));
        const count = node('span', 'agent-chat-topic-selection-count', `已选择 ${model.topicSelectedIds.size} 项`);
        count.setAttribute('aria-live', 'polite');
        selection.append(selectAll, count);
        const controls = node('div', 'next-ui-topic-manage-actions');
        const archive = button('', 'next-ui-topic-manage-button danger');
        archive.title = '归档所选会话';
        archive.setAttribute('aria-label', '归档所选会话');
        archive.disabled = model.topicSelectedIds.size === 0;
        archive.append(...icon('delete'));
        archive.addEventListener('click', () => actions.archiveSelectedSessions(
            persistedTopics.filter((topic) => model.topicSelectedIds.has(topic.id)),
        ));
        const exit = button('', 'next-ui-topic-manage-button');
        exit.title = '退出管理';
        exit.setAttribute('aria-label', '退出会话管理');
        exit.append(...icon('close'));
        exit.addEventListener('click', actions.exitTopicManagement);
        controls.append(archive, exit);
        panel.append(selection, controls);
        content.append(panel);
    }

    function renderSessions(content, tabs) {
        const header = node('div', 'topics-header-container');
        const tools = node('div', 'next-ui-topic-tools');
        const add = visualActionButton('add', '新建会话', 'next-ui-create-topic-trigger', '新建会话');
        add.disabled = model.topicCreating || model.profileHistorical;
        if (model.profileHistorical) {
            add.title = '历史会话仅可查看，不能新建会话';
            add.setAttribute('aria-label', '历史会话不能新建会话');
        }
        add.addEventListener('click', actions.openNewSession);
        const manage = visualActionButton('checklist', '管理会话', 'next-ui-topic-icon-trigger');
        manage.disabled = model.showArchivedTopics;
        manage.classList.toggle('active', model.topicManaging);
        manage.setAttribute('aria-pressed', String(model.topicManaging));
        manage.addEventListener('click', actions.toggleTopicManagement);
        const searchTrigger = visualActionButton('search', '搜索会话', 'next-ui-topic-icon-trigger');
        searchTrigger.setAttribute('aria-expanded', String(model.topicSearchOpen));
        const archiveToggle = visualActionButton('archive', model.showArchivedTopics ? '返回当前会话' : '查看归档会话', 'next-ui-topic-icon-trigger');
        archiveToggle.setAttribute('aria-pressed', String(model.showArchivedTopics));
        archiveToggle.addEventListener('click', actions.toggleArchivedSessions);
        tools.append(add, manage, searchTrigger, archiveToggle);

        const { panel: searchPanel, input: search, close } = createSidebarSearchPanel(
            'agentWorkbenchTopicSearchInput', '搜索 Agent 会话', '搜索会话...',
            'next-ui-topic-search-close', '关闭会话搜索',
        );
        search.value = model.topicSearch;
        searchTrigger.setAttribute('aria-controls', search.id);
        header.classList.toggle('is-searching', model.topicSearchOpen);
        const setSearchOpen = (open, clear = !open) => {
            actions.setTopicSearchOpen(open, clear);
            if (open) queueMicrotask(() => search.focus());
        };
        searchTrigger.addEventListener('click', () => setSearchOpen(true, false));
        close.addEventListener('click', () => setSearchOpen(false));
        search.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setSearchOpen(false);
            searchTrigger.focus();
        });
        header.append(tools, searchPanel);
        content.append(header);

        if (model.profileConfigurationRequired) {
            const warning = node('section', 'agent-chat-profile-configuration-warning');
            warning.setAttribute('role', 'status');
            warning.append(
                node('strong', '', '需要配置 Agent 提示词'),
                node('span', '', model.profileConfigurationNotice
                    || `Agent「${model.selectedAgentName || model.selectedAgent}」缺少提示词，暂时不能新建会话。`),
            );
            const configure = button('去设置', 'secondary agent-chat-profile-configuration-action');
            configure.addEventListener('click', () => actions.selectTab('settings'));
            warning.append(configure);
            content.append(warning);
        }

        const list = node('ul', 'topic-list agent-chat-session-list');
        const indexedTopics = model.topicSearch.trim()
            ? model.topicSearchResults.map((hit) => ({
                id: hit.sessionId,
                title: hit.title || hit.sessionId,
                agentId: hit.agentId,
                inUse: hit.inUse === true,
                readOnly: hit.readOnly === true,
                model: hit.model || '',
                workspaceRef: hit.workspaceRef || '',
                updatedAt: hit.updatedAt || hit.timestamp || 0,
                searchHit: hit,
            }))
            : model.persistedTopics;
        const persistedTopics = indexedTopics
            .filter((topic) => !model.liveSessions.some((session) => session.sessionId === topic.id));
        if (!model.topicSearch.trim() && !model.liveSessions.length && !persistedTopics.length) {
            if (model.topicListLoading) {
                for (let index = 0; index < 4; index += 1) list.append(node('li', 'topic-item agent-chat-session-row agent-chat-session-skeleton', ''));
            } else {
                list.append(node('li', 'agent-chat-empty-list', model.showArchivedTopics
                    ? `${model.selectedAgent || '当前 Agent'} 没有已归档会话。`
                    : `${model.selectedAgent || '当前 Agent'} 还没有会话。创建一个会话后即可开始。`));
            }
        }
        model.liveSessions.forEach((session) => list.append(createSessionRow(session)));
        persistedTopics.forEach((topic) => list.append(createPersistedRow(topic)));

        const applyFilter = () => {
            const query = normalized(search.value);
            for (const row of list.querySelectorAll('[data-topic-search]')) {
                row.hidden = Boolean(query) && !model.topicSearchResults.length
                    && !row.dataset.topicSearch.includes(query);
            }
        };
        search.addEventListener('input', () => {
            applyFilter();
            lifecycle.clear('topic-search');
            const query = search.value.trim();
            const request = ++searchRequest;
            actions.setTopicSearch(query, { loading: Boolean(query), error: '', render: !query });
            if (!query) return;
            lifecycle.timeout('topic-search', async () => {
                try {
                    const hits = await actions.searchSessions(query, model.selectedAgent, 50);
                    if (request !== searchRequest) return;
                    actions.finishTopicSearch(query, { hits });
                } catch (error) {
                    if (request !== searchRequest) return;
                    actions.finishTopicSearch(query, { error: error?.message || String(error) });
                }
            }, 180);
        });
        applyFilter();
        const scroll = node('div', 'sidebar-list-scroll');
        scroll.append(list);
        if (model.topicSearchLoading) scroll.prepend(node('div', 'agent-chat-empty-list', '正在搜索 Agent 会话…'));
        else if (model.topicSearchError) scroll.prepend(node('div', 'agent-chat-empty-list', `索引搜索不可用：${model.topicSearchError}`));
        else if (model.topicSearch.trim() && !persistedTopics.length) scroll.prepend(node('div', 'agent-chat-empty-list', '没有匹配的 Agent Topic。'));
        content.append(scroll);
        renderSessionManagement(content, list, persistedTopics);
        if (!model.topicManaging && !model.topicSearchOpen && !model.topicSearch.trim()) {
            sessionShell = { tabs, content, header, list, scroll, agentId: model.selectedAgent };
        }
    }

    function renderAgents(content) {
        const header = node('div', 'agents-header');
        const tools = node('div', 'next-ui-agent-tools');
        const add = visualActionButton('add', '新建 Build Agent', 'next-ui-create-item-trigger', '新建 Build Agent');
        add.addEventListener('click', actions.openNewAgent);
        const trigger = visualActionButton('search', '搜索助手或群', 'next-ui-agent-search-trigger');
        trigger.setAttribute('aria-expanded', String(Boolean(model.agentSearch)));
        tools.append(add, trigger);
        const { panel, input, close } = createSidebarSearchPanel(
            'agentWorkbenchSearchInput', '搜索助手或群', '搜索助手或群...',
            'next-ui-agent-search-close', '关闭助手搜索',
        );
        input.value = model.agentSearch;
        trigger.setAttribute('aria-controls', input.id);
        const setOpen = (open, clear = !open) => {
            header.classList.toggle('is-searching', open);
            trigger.setAttribute('aria-expanded', String(open));
            if (clear) {
                actions.setAgentSearch('');
                input.value = '';
            }
            if (open) queueMicrotask(() => input.focus());
        };
        trigger.addEventListener('click', () => setOpen(true, false));
        close.addEventListener('click', () => setOpen(false));
        header.append(tools, panel);
        content.append(header);
        const list = node('ul', 'agent-list agent-chat-agent-list');
        for (const agent of model.agentCatalog) {
            const agentId = agent.id || agent.name;
            const row = node('li', `agent-chat-agent-row${normalized(agentId) === normalized(model.selectedAgent) ? ' active' : ''}${agent.configurationRequired ? ' configuration-required' : ''}`);
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.dataset.agentSearch = `${agent.name || ''} ${agentId || ''} ${agent.historicalLabel || ''}`.toLocaleLowerCase();
            const avatar = document.createElement('img');
            avatar.className = 'avatar';
            avatar.src = agent.avatarUrl || 'assets/default_avatar.png';
            avatar.alt = `${agent.name || agentId} 头像`;
            avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
            const displayName = agent.historical
                ? `${agent.name || agentId}（${agent.historicalLabel || '历史会话'}）`
                : (agent.name || agentId);
            row.append(avatar, node('span', 'agent-name', displayName));
            if (agent.historical) {
                row.title = '仅用于打开此 Agent 的历史会话；不能作为新的 Build Agent 配置。';
            }
            if (agent.configurationRequired) {
                const warning = node('span', 'vcp-ui-icon agent-chat-agent-configuration-icon', 'warning');
                warning.title = '缺少 Agent 提示词';
                warning.setAttribute('aria-label', '缺少 Agent 提示词');
                row.append(warning);
            }
            row.addEventListener('click', () => actions.selectAgent(agentId));
            activateOnKeyboard(row, () => actions.selectAgent(agentId));
            list.append(row);
        }
        if (!model.agentCatalog.length) list.append(node('li', 'agent-chat-empty-list', '正在读取 Agent 目录…'));
        input.addEventListener('input', () => {
            actions.setAgentSearch(input.value);
            for (const row of list.querySelectorAll('[data-agent-search]')) {
                row.hidden = Boolean(input.value.trim())
                    && !row.dataset.agentSearch.includes(normalized(input.value));
            }
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setOpen(false);
            trigger.focus();
        });
        const scroll = node('div', 'sidebar-list-scroll');
        scroll.append(list);
        content.append(scroll);
    }

    function render() {
        if (!model) return;
        if (patchSessionRows()) return;
        invalidateSessionShell();
        const scrollTop = element.scrollTop;
        element.replaceChildren();
        const tabs = renderTabs();
        const content = node('div', 'sidebar-tab-content active agent-chat-sidebar-content');
        if (model.tab === 'sessions') renderSessions(content, tabs);
        else if (model.tab === 'agents') renderAgents(content);
        else content.append(actions.renderSettings());
        accountView.update();
        element.append(tabs, content, accountView.element);
        if (element.scrollTop !== scrollTop) element.scrollTop = scrollTop;
    }

    return {
        element,
        update(nextModel) {
            model = nextModel;
            render();
        },
        dispose() {
            searchRequest += 1;
            lifecycle.clear('topic-search');
            invalidateSessionShell();
            element.replaceChildren();
        },
    };
}
