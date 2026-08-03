import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import { createWorkspacePathRef } from './agent-workspace-model.js';

function normalizeDockKind(tab) {
    return ({ usage: 'context', workspace: 'files', activity: 'notifications' })[tab] || tab || 'context';
}

function createAgentActivityCoordinator({
    state, store, document, node, refs, sessionDockView, activityReadonlyView,
    approvalView, notificationView, workspaceView, workspaceCoordinator,
    queueRender, run, launchTerminal,
}) {
    const { activityPanel, activitySplitter } = refs;
    let disposed = false;

    function selectedSessionId(current = store.getState()) {
        return current.selectedSessionId || current.selectedTopic?.sessionId || '';
    }

    function selectedWorkspaceIdentity(current = store.getState()) {
        const selected = current.selectedTopic || {};
        return {
            sessionId: current.selectedSessionId || selected.sessionId || '',
            workspaceRoot: selected.workspaceRef || selected.workspaceRoot || '',
        };
    }

    function syncDock(current = store.getState()) {
        state.sessionDock.setSession(selectedSessionId(current));
        const snapshot = state.sessionDock.snapshot();
        state.activityTab = snapshot.activeId;
        return snapshot;
    }

    function clearUnread(tab) {
        const normalized = normalizeDockKind(tab);
        const current = store.getState();
        const byTab = { ...(current.activityUnreadByTab || {}) };
        const legacyTab = ({ context: 'usage', files: 'workspace', notifications: 'activity' })[normalized];
        if (!byTab[normalized] && !(legacyTab && byTab[legacyTab])) return;
        byTab[normalized] = 0;
        if (legacyTab) byTab[legacyTab] = 0;
        store.setState({
            activityUnreadByTab: byTab,
            activityUnread: Object.values(byTab).reduce((sum, value) => sum + Number(value || 0), 0),
        });
    }

    function setOpen(open, tab) {
        if (disposed) return;
        if (open && tab) {
            state.sessionDock.setSession(selectedSessionId());
            state.sessionDock.openKind(normalizeDockKind(tab));
            state.activityTab = state.sessionDock.snapshot().activeId;
        }
        state.activityOpen = open;
        if (open) clearUnread(state.activityTab);
        activitySplitter.classList.toggle('is-active', open);
        activityPanel.classList.toggle('agent-chat-activity-open', open);
        activityPanel.classList.toggle('agent-chat-activity-collapsed', !open);
        if (open) activityPanel.removeAttribute('inert');
        else activityPanel.setAttribute('inert', '');
        activityPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
        queueRender({ activity: true, header: true });
    }

    function openKind(kind) {
        state.sessionDock.setSession(selectedSessionId());
        state.sessionDock.openKind(normalizeDockKind(kind));
        state.activityTab = state.sessionDock.snapshot().activeId;
        state.dockMenuOpen = false;
        setOpen(true);
    }

    function menuCommands() {
        const current = store.getState();
        const changesAvailable = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .some((tool) => Array.isArray(tool?.payload?.changes?.files) && tool.payload.changes.files.length);
        return [
            { icon: 'folder_open', label: '打开文件', run: () => openKind('files') },
            ...(changesAvailable ? [{ icon: 'difference', label: '查看变更', run: () => openKind('changes') }] : []),
            { icon: 'data_usage', label: '上下文', run: () => openKind('context') },
            { icon: 'notifications', label: '通知', run: () => openKind('notifications') },
            { icon: 'approval', label: '审批', run: () => openKind('approvals') },
            { icon: 'terminal', label: '在 VChat 终端中打开', run: () => run(async () => {
                await launchTerminal();
                if (disposed) return;
                state.dockMenuOpen = false;
                render();
            }) },
        ];
    }

    function maybeAutoOpen() {
        const current = store.getState();
        const approvalsCount = (current.approvals || []).length;
        if (approvalsCount > 0 && !state.hadApprovals && !state.activityOpen) setOpen(true, 'approvals');
        state.lastViewState = deriveWorkbenchViewState(current);
        state.hadApprovals = approvalsCount > 0;
    }

    function syncWorkspace(current = store.getState()) { return workspaceCoordinator.syncScope(current); }
    function loadDirectory(relativePath = '') { return workspaceCoordinator.loadDirectory(relativePath, store.getState()); }
    function openPreview(ref) { return workspaceCoordinator.openPreview(ref); }
    function performPathAction(ref, action) { return workspaceCoordinator.performAction(ref, action); }
    function search(value) { workspaceCoordinator.search(value); }

    async function openFileTab(ref) {
        state.sessionDock.setSession(selectedSessionId());
        const snapshot = state.sessionDock.openFile(ref);
        if (!snapshot) throw new Error('文件引用不属于当前会话或工作区版本已失效。');
        state.activityTab = snapshot.activeId;
        await workspaceCoordinator.openPreview(ref);
        if (!disposed) setOpen(true);
    }

    async function openSourcePath(relativePath, source = 'tree', action = 'preview') {
        syncWorkspace();
        if (!state.workspaceBrowser.workspaceRevision) await loadDirectory('');
        if (disposed) return null;
        const browser = state.workspaceBrowser;
        const ref = createWorkspacePathRef({
            sessionId: browser.sessionId,
            workspaceRevision: browser.workspaceRevision,
            relativePath,
            source,
        });
        if (action === 'preview') {
            setOpen(true, 'files');
            return openPreview(ref);
        }
        if (action === 'open-in-vchat') return openFileTab(ref);
        return performPathAction(ref, action);
    }

    function render() {
        if (disposed || state.disposed) return;
        const current = store.getState();
        const previousContent = sessionDockView.activePanel();
        const previousTab = state.sessionDock.snapshot().tabs.find((tab) => tab.id === state.activityTab);
        const previousScrollTarget = previousTab?.kind === 'notifications'
            ? previousContent?.querySelector('.agent-chat-activity-list') : previousContent;
        const scrollTop = previousScrollTarget?.scrollTop || 0;
        const activeElement = document.activeElement;
        const searchFocused = activeElement?.matches?.('.agent-chat-activity-filters input[type="search"]');
        const searchSelection = searchFocused ? [activeElement.selectionStart, activeElement.selectionEnd] : null;
        const openKeys = new Set([...activityPanel.querySelectorAll('details[open][data-activity-key]')]
            .map((item) => item.dataset.activityKey));
        const localApprovals = current.approvals || [];
        const backendApprovals = (current.toolboxWs || []).filter((item) => item?.kind === 'backend-approval-request');
        const interactionKey = (source, requestId) => `${String(source || 'codex-native')}:${String(requestId || '')}`;
        const actionable = new Set([
            ...localApprovals.map((item) => interactionKey(item.scope || 'codex-native', item.requestId || item.approvalId)),
            ...backendApprovals.map((item) => interactionKey('toolbox', item?.value?.requestId || item?.value?.data?.requestId)),
        ]);
        const passiveInteractions = (current.interactions || [])
            .filter((item) => !actionable.has(interactionKey(item.source, item.requestId)));
        const unread = current.activityUnreadByTab || {};
        syncDock(current);
        state.sessionDock.setBadge('notifications', Number(unread.notifications || unread.activity || 0));
        state.sessionDock.setBadge('approvals', localApprovals.length + backendApprovals.length + passiveInteractions.length);
        const tabs = state.sessionDock.snapshot().tabs;
        if (!tabs.some((tab) => tab.id === state.activityTab)) state.activityTab = 'context';
        const content = sessionDockView.update({
            tabs, activeId: state.activityTab, menuOpen: state.dockMenuOpen, commands: menuCommands(),
        });
        content.replaceChildren();
        const definition = tabs.find((tab) => tab.id === state.activityTab) || tabs[0];
        const kind = definition?.kind || 'context';
        if (kind === 'connection') content.append(activityReadonlyView.buildConnection(current, deriveWorkbenchViewState(current)));
        else if (kind === 'approvals') {
            approvalView.update({ localApprovals, backendApprovals, interactions: passiveInteractions });
            content.append(approvalView.element);
        }
        else if (kind === 'context') content.append(activityReadonlyView.buildUsage(current));
        else if (kind === 'plan') content.append(activityReadonlyView.buildPlan(current));
        else if (kind === 'changes') content.append(activityReadonlyView.buildChanges(current, {
            sessionId: selectedSessionId(current),
            workspaceRevision: state.workspaceBrowser.sessionId === selectedSessionId(current)
                ? state.workspaceBrowser.workspaceRevision : '',
        }));
        else if (kind === 'files') {
            workspaceView.update({ identity: syncWorkspace(current), browser: state.workspaceBrowser });
            content.append(workspaceView.element);
        } else if (kind === 'file') {
            syncWorkspace(current);
            const ref = createWorkspacePathRef({
                sessionId: definition.sessionId,
                workspaceRevision: definition.workspaceRevision,
                relativePath: definition.relativePath,
                source: 'tree',
            });
            if (state.workspaceBrowser.preview?.relativePath !== definition.relativePath
                || state.workspaceBrowser.preview?.workspaceRevision !== definition.workspaceRevision) {
                content.append(node('div', 'agent-chat-activity-empty', '正在读取文件…'));
                if (!state.workspaceBrowser.previewLoading) queueMicrotask(() => {
                    if (!disposed) run(() => openPreview(ref));
                });
            } else content.append(workspaceView.renderPreview(state.workspaceBrowser));
        } else {
            notificationView.update(current);
            content.append(notificationView.element);
        }
        for (const details of content.querySelectorAll('details[data-activity-key]')) {
            if (openKeys.has(details.dataset.activityKey)) details.open = true;
        }
        const scrollTarget = kind === 'notifications' ? content.querySelector('.agent-chat-activity-list') : content;
        if (scrollTarget) scrollTarget.scrollTop = scrollTop;
        if (searchFocused) {
            const nextSearch = content.querySelector('.agent-chat-activity-filters input[type="search"]');
            nextSearch?.focus();
            if (searchSelection) nextSearch?.setSelectionRange?.(...searchSelection);
        }
    }

    return Object.freeze({
        normalizeKind: normalizeDockKind,
        selectedSessionId,
        selectedWorkspaceIdentity,
        syncDock,
        clearUnread,
        setOpen,
        openKind,
        maybeAutoOpen,
        syncWorkspace,
        loadDirectory,
        openPreview,
        openFileTab,
        performPathAction,
        openSourcePath,
        search,
        render,
        dispose() { disposed = true; },
    });
}

export { createAgentActivityCoordinator, normalizeDockKind };
