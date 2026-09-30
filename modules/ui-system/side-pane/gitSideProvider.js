/**
 * modules/ui-system/side-pane/gitSideProvider.js
 * VCPChat Universal Sub-screen - Git Source Control Provider
 *
 * Faithfully aligned with ZCode GitPane & GitPaneChangeCard specifications:
 * 1. Top Bar: Source dataset selector (unstaged / staged / all) + Ghost refresh button + ProjectForge full launcher.
 * 2. Secondary Sub-Bar: Clean workspace switcher + branch pill + sync status badge (ahead/behind).
 * 3. Change Card Row: 32px height (h-8), sticky top with backdrop blur, file icon, bold basename, muted folder path, +N/-M diff counters, and 180deg rotating chevron.
 * 4. Context Menu / Row Actions: Non-disruptive actions (Stage/Unstage, Discard, Copy Path, and 📌 Quote to Chat).
 * 5. Inline Diff Viewer: LCS line-by-line diff, gutter line numbers, and deep Code Viewer sub-screen linkage.
 * 6. Bottom Dock: Collapsible/compact commit bar docked at the bottom with (Ctrl+Enter) shortcut.
 * 7. Empty State: Centered 32px file icon with 2-line title and description.
 */

'use strict';

import { computeLineDiff } from './codeViewerSideProvider.js';

const STORAGE_KEY_WS = 'vcp-side-pane-git-workspace';
const STORAGE_KEY_SOURCE = 'vcp-side-pane-git-source';
const POLL_INTERVAL_MS = 8000;

const STATUS_TEXT = Object.freeze({
    M: '已修改',
    A: '已添加',
    D: '已删除',
    R: '已重命名',
    C: '已复制',
    T: '类型变更',
    U: '未跟踪',
    '!': '冲突'
});

function getStorage(doc) {
    try {
        return doc?.defaultView?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch (_e) {
        return null;
    }
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function createGitSideProvider({
    electronAPI = null,
    sidePaneController = null,
    onOpenCodeViewer = null,
    onOpenProjectForge = null,
    uiHelper = null
} = {}) {
    const api = electronAPI || (typeof window !== 'undefined' ? (window.electronAPI || window.utilityAPI) : null);

    return Object.freeze({
        kind: 'git',

        async openGitTab(options = {}) {
            if (!sidePaneController) return null;
            const tabDesc = {
                id: options.id || 'side-pane-git',
                kind: 'git',
                title: options.title || 'Git 变更',
                icon: 'branch',
                closable: true,
                scopeMode: 'global',
                ...options
            };
            const handle = await sidePaneController.openTab(tabDesc);
            sidePaneController.setVisible(true);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tabDescriptor, viewElement) {
            if (!viewElement) return null;

            const doc = viewElement.ownerDocument || document;
            const storage = getStorage(doc);

            viewElement.innerHTML = '';
            viewElement.classList.add('side-git-view');

            const container = doc.createElement('div');
            container.className = 'side-git-container';

            // Internal State
            let currentWorkspaceId = storage?.getItem(STORAGE_KEY_WS) || null;
            let currentSource = storage?.getItem(STORAGE_KEY_SOURCE) || 'all'; // 'all' | 'unstaged' | 'staged'
            let currentStatus = null;
            let pollTimer = null;
            let isDisposed = false;
            let expandedDiffMap = new Map(); // relPath -> diffDetails

            // 1. Header Toolbar (ZCode GitPane Top Bar Pattern)
            const header = doc.createElement('header');
            header.className = 'side-git-header';

            // Top Row: Source Dataset Selector + Ghost Refresh Button + Full Window Launcher
            const topRow = doc.createElement('div');
            topRow.className = 'side-git-top-row';

            const sourceSelect = doc.createElement('select');
            sourceSelect.className = 'side-git-source-select';
            sourceSelect.setAttribute('aria-label', '选择变更来源');

            const optAll = doc.createElement('option');
            optAll.value = 'all';
            optAll.textContent = '全部更改';

            const optUnstaged = doc.createElement('option');
            optUnstaged.value = 'unstaged';
            optUnstaged.textContent = '未暂存更改';

            const optStaged = doc.createElement('option');
            optStaged.value = 'staged';
            optStaged.textContent = '暂存更改';

            sourceSelect.append(optAll, optUnstaged, optStaged);
            sourceSelect.value = currentSource;

            const topActions = doc.createElement('div');
            topActions.className = 'side-git-top-actions';

            const refreshBtn = doc.createElement('button');
            refreshBtn.type = 'button';
            refreshBtn.className = 'side-pane-action-btn side-git-refresh-btn';
            refreshBtn.title = '刷新 Git 状态';
            refreshBtn.innerHTML = '<span class="vcp-ui-icon">refresh</span><span class="side-git-btn-label">刷新</span>';

            const fullWindowBtn = doc.createElement('button');
            fullWindowBtn.type = 'button';
            fullWindowBtn.className = 'side-pane-action-btn side-git-full-btn';
            fullWindowBtn.title = '在独立窗口中打开完整施工图 (ProjectForge)';
            fullWindowBtn.innerHTML = '<span class="vcp-ui-icon">open_in_new</span>';

            topActions.append(refreshBtn, fullWindowBtn);
            topRow.append(sourceSelect, topActions);

            // Sub Row: Workspace Pill + Branch Badge + Sync Badge
            const subRow = doc.createElement('div');
            subRow.className = 'side-git-sub-row';

            const wsWrapper = doc.createElement('div');
            wsWrapper.className = 'side-git-ws-wrapper';

            const wsIcon = doc.createElement('span');
            wsIcon.className = 'vcp-ui-icon side-git-ws-icon';
            wsIcon.textContent = 'folder';

            const wsSelect = doc.createElement('select');
            wsSelect.className = 'side-git-ws-select';
            wsSelect.setAttribute('aria-label', '选择 Git 工作区');

            wsWrapper.append(wsIcon, wsSelect);

            const metaWrapper = doc.createElement('div');
            metaWrapper.className = 'side-git-meta-wrapper';

            const branchBadge = doc.createElement('span');
            branchBadge.className = 'side-git-branch-badge';
            branchBadge.innerHTML = '<span class="vcp-ui-icon">branch</span><span class="branch-name">-</span>';

            const syncBadge = doc.createElement('span');
            syncBadge.className = 'side-git-sync-badge';
            syncBadge.style.display = 'none';

            metaWrapper.append(branchBadge, syncBadge);
            subRow.append(wsWrapper, metaWrapper);

            header.append(topRow, subRow);

            // Notice / Status notification banner
            const noticeEl = doc.createElement('div');
            noticeEl.className = 'side-git-notice';
            noticeEl.style.display = 'none';

            // 2. File Changes Body (Scrollable primary viewport)
            const body = doc.createElement('div');
            body.className = 'side-git-body';

            const emptyState = doc.createElement('div');
            emptyState.className = 'side-git-empty';
            emptyState.innerHTML = `
                <span class="vcp-ui-icon empty-icon">description</span>
                <p class="side-git-empty-title">工作区很干净</p>
                <p class="side-git-empty-desc">没有检测到任何未提交的代码更改</p>
            `;

            const groupsContainer = doc.createElement('div');
            groupsContainer.className = 'side-git-groups';

            body.append(emptyState, groupsContainer);

            // 3. Commit & Push Dock (Docked cleanly at bottom, ZCode/VSCode style)
            const commitDock = doc.createElement('section');
            commitDock.className = 'side-git-commit-dock side-git-commit-section';

            const commitInput = doc.createElement('textarea');
            commitInput.className = 'side-git-commit-input';
            commitInput.rows = 2;
            commitInput.placeholder = '提交信息 (Ctrl+Enter 提交)...';
            commitInput.setAttribute('aria-label', 'Git 提交信息');

            const commitActions = doc.createElement('div');
            commitActions.className = 'side-git-commit-actions';

            const commitBtn = doc.createElement('button');
            commitBtn.type = 'button';
            commitBtn.className = 'side-git-btn primary';
            commitBtn.innerHTML = '<span class="vcp-ui-icon">check</span><span>提交</span>';
            commitBtn.disabled = true;

            const pushBtn = doc.createElement('button');
            pushBtn.type = 'button';
            pushBtn.className = 'side-git-btn';
            pushBtn.innerHTML = '<span class="vcp-ui-icon">upload</span><span>推送</span>';
            pushBtn.disabled = true;

            commitActions.append(commitBtn, pushBtn);
            commitDock.append(commitInput, commitActions);

            // Assemble Container: Header -> Notice -> Body -> Bottom Commit Dock
            container.append(header, noticeEl, body, commitDock);
            viewElement.appendChild(container);

            function showNotice(text, type = 'info', durationMs = 4000) {
                noticeEl.textContent = text;
                noticeEl.className = `side-git-notice ${type}`;
                noticeEl.style.display = 'block';
                if (durationMs > 0) {
                    setTimeout(() => {
                        if (!isDisposed && noticeEl.textContent === text) {
                            noticeEl.style.display = 'none';
                        }
                    }, durationMs);
                }
            }

            async function loadWorkspaces() {
                if (!api?.gitListWorkspaces) return;
                try {
                    const res = await api.gitListWorkspaces();
                    const list = res?.success ? res.data : (Array.isArray(res) ? res : []);
                    wsSelect.innerHTML = '';
                    if (!list || list.length === 0) {
                        const opt = doc.createElement('option');
                        opt.value = '';
                        opt.textContent = '暂无可用工作区';
                        wsSelect.appendChild(opt);
                        branchBadge.querySelector('.branch-name').textContent = '无工作区';
                        return;
                    }

                    list.forEach(ws => {
                        const opt = doc.createElement('option');
                        opt.value = ws.id;
                        opt.textContent = `${ws.alias || '工作区'} (${ws.path})`;
                        if (ws.id === currentWorkspaceId) opt.selected = true;
                        wsSelect.appendChild(opt);
                    });

                    if (!currentWorkspaceId || !list.some(ws => ws.id === currentWorkspaceId)) {
                        currentWorkspaceId = list[0].id;
                        wsSelect.value = currentWorkspaceId;
                        storage?.setItem(STORAGE_KEY_WS, currentWorkspaceId);
                    }

                    await refreshStatus({ quiet: false });
                } catch (err) {
                    console.error('[GitSideProvider] Failed to list workspaces:', err);
                    showNotice('加载工作区失败: ' + err.message, 'error');
                }
            }

            async function refreshStatus({ quiet = false } = {}) {
                if (!api?.gitStatus || !currentWorkspaceId || isDisposed) return;
                if (!quiet) refreshBtn.classList.add('spinning');
                try {
                    const res = await api.gitStatus(currentWorkspaceId);
                    if (!res?.success) {
                        throw new Error(res?.error || '获取 Git 状态失败');
                    }
                    currentStatus = res.data;
                    renderStatus(currentStatus);
                } catch (err) {
                    if (!quiet) showNotice(err.message, 'error');
                } finally {
                    refreshBtn.classList.remove('spinning');
                }
            }

            function renderStatus(status) {
                if (!status || !status.isRepo) {
                    branchBadge.querySelector('.branch-name').textContent = status?.isRepo === false ? '非 Git 仓库' : '离线';
                    syncBadge.style.display = 'none';
                    groupsContainer.innerHTML = '';
                    emptyState.style.display = 'flex';
                    emptyState.innerHTML = `
                        <span class="vcp-ui-icon empty-icon">folder_off</span>
                        <p class="side-git-empty-title">当前目录不是 Git 仓库</p>
                        <p class="side-git-empty-desc">请切换到包含 .git 的有效工作区目录</p>
                    `;
                    commitBtn.disabled = true;
                    pushBtn.disabled = true;
                    return;
                }

                // Branch & Sync
                const branchName = status.branch || 'HEAD';
                branchBadge.querySelector('.branch-name').textContent = branchName;

                if (status.ahead > 0 || status.behind > 0) {
                    syncBadge.style.display = 'inline-flex';
                    syncBadge.textContent = `↑${status.ahead || 0} ↓${status.behind || 0}`;
                    syncBadge.title = `领先 ${status.ahead || 0} 个提交，落后 ${status.behind || 0} 个提交`;
                } else {
                    syncBadge.style.display = 'none';
                }

                const staged = status.staged || [];
                const changes = status.changes || [];
                const conflicts = status.conflicts || [];
                const totalCount = staged.length + changes.length + conflicts.length;

                commitBtn.disabled = staged.length === 0;
                pushBtn.disabled = (status.ahead || 0) === 0;

                if (totalCount === 0) {
                    emptyState.style.display = 'flex';
                    emptyState.innerHTML = `
                        <span class="vcp-ui-icon empty-icon">check_circle</span>
                        <p class="side-git-empty-title">工作区很干净</p>
                        <p class="side-git-empty-desc">没有检测到任何未提交的代码更改</p>
                    `;
                    groupsContainer.innerHTML = '';
                    return;
                }

                emptyState.style.display = 'none';
                groupsContainer.innerHTML = '';

                // Filtering by currentSource ('all' | 'unstaged' | 'staged')
                const showStaged = currentSource === 'all' || currentSource === 'staged';
                const showUnstaged = currentSource === 'all' || currentSource === 'unstaged';

                // Conflicts Group
                if (conflicts.length > 0) {
                    groupsContainer.appendChild(createGroupEl('conflicts', '合并冲突', conflicts));
                }

                // Staged Group
                if (showStaged && staged.length > 0) {
                    groupsContainer.appendChild(createGroupEl('staged', '暂存的更改', staged));
                }

                // Unstaged Changes Group
                if (showUnstaged && changes.length > 0) {
                    groupsContainer.appendChild(createGroupEl('changes', '更改', changes));
                }

                if (groupsContainer.children.length === 0) {
                    emptyState.style.display = 'flex';
                    const srcLabel = currentSource === 'staged' ? '暂存区' : '未暂存区';
                    emptyState.innerHTML = `
                        <span class="vcp-ui-icon empty-icon">filter_alt</span>
                        <p class="side-git-empty-title">${srcLabel}中没有更改</p>
                        <p class="side-git-empty-desc">可切换上方来源下拉框查看其他变更</p>
                    `;
                }
            }

            function createGroupEl(groupKey, title, items) {
                const groupEl = doc.createElement('section');
                groupEl.className = `side-git-group group-${groupKey}`;

                const groupHead = doc.createElement('div');
                groupHead.className = 'side-git-group-head';

                const titleSpan = doc.createElement('span');
                titleSpan.className = 'side-git-group-title';
                titleSpan.innerHTML = `<strong>${title}</strong> <span class="group-count">(${items.length})</span>`;

                const groupActions = doc.createElement('div');
                groupActions.className = 'side-git-group-actions';

                if (groupKey === 'staged') {
                    const unstageAllBtn = doc.createElement('button');
                    unstageAllBtn.type = 'button';
                    unstageAllBtn.className = 'side-git-batch-btn';
                    unstageAllBtn.title = '取消暂存所有文件';
                    unstageAllBtn.innerHTML = '<span class="vcp-ui-icon">remove</span>';
                    unstageAllBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await batchUnstage(items.map(i => i.path));
                    });
                    groupActions.appendChild(unstageAllBtn);
                } else if (groupKey === 'changes') {
                    const stageAllBtn = doc.createElement('button');
                    stageAllBtn.type = 'button';
                    stageAllBtn.className = 'side-git-batch-btn';
                    stageAllBtn.title = '暂存所有更改';
                    stageAllBtn.innerHTML = '<span class="vcp-ui-icon">add</span>';
                    stageAllBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await batchStage(items.map(i => i.path));
                    });
                    groupActions.appendChild(stageAllBtn);
                }

                groupHead.append(titleSpan, groupActions);
                groupEl.appendChild(groupHead);

                const listEl = doc.createElement('ul');
                listEl.className = 'side-git-file-list';

                items.forEach(item => {
                    const row = createFileCardRow(groupKey, item);
                    listEl.appendChild(row);
                });

                groupEl.appendChild(listEl);
                return groupEl;
            }

            // Aligned 1:1 with ZCode GitPaneChangeCard specifications
            function createFileCardRow(groupKey, item) {
                const li = doc.createElement('li');
                li.className = 'side-git-file-item';
                li.setAttribute('data-path', item.path);

                const mainRow = doc.createElement('div');
                mainRow.className = 'side-git-file-row';
                mainRow.setAttribute('role', 'button');
                mainRow.setAttribute('tabindex', '0');
                mainRow.setAttribute('aria-expanded', expandedDiffMap.has(item.path) ? 'true' : 'false');

                // Left: File Display Inline (Icon + Status + Basename + Directory)
                const fileLabel = doc.createElement('div');
                fileLabel.className = 'side-git-file-label';
                fileLabel.title = item.path;

                const statusLetter = item.status || '?';
                const statusBadge = doc.createElement('span');
                statusBadge.className = `side-git-file-status status-${statusLetter.toLowerCase()}`;
                statusBadge.textContent = statusLetter;
                statusBadge.title = STATUS_TEXT[statusLetter] || statusLetter;

                const slashIdx = item.path.lastIndexOf('/');
                const fileName = slashIdx >= 0 ? item.path.slice(slashIdx + 1) : item.path;
                const dirPath = slashIdx >= 0 ? item.path.slice(0, slashIdx) : '';

                const baseNameSpan = doc.createElement('span');
                baseNameSpan.className = 'side-git-file-basename';
                baseNameSpan.textContent = fileName;

                fileLabel.append(statusBadge, baseNameSpan);

                if (dirPath) {
                    const dirSpan = doc.createElement('span');
                    dirSpan.className = 'side-git-file-dir';
                    dirSpan.textContent = ` ${dirPath}`;
                    fileLabel.appendChild(dirSpan);
                }

                // Right: Actions + Diff Stats (+added / -removed) + Chevron (180deg rotating)
                const metaContainer = doc.createElement('div');
                metaContainer.className = 'side-git-file-meta';

                const actionsWrapper = doc.createElement('div');
                actionsWrapper.className = 'side-git-row-actions';

                // Single file operations (Stage / Unstage / Discard)
                if (groupKey === 'staged') {
                    const unstageBtn = doc.createElement('button');
                    unstageBtn.type = 'button';
                    unstageBtn.className = 'side-git-row-action-btn';
                    unstageBtn.title = '取消暂存';
                    unstageBtn.innerHTML = '<span class="vcp-ui-icon">remove</span>';
                    unstageBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await batchUnstage([item.path]);
                    });
                    actionsWrapper.appendChild(unstageBtn);
                } else if (groupKey === 'changes') {
                    const stageBtn = doc.createElement('button');
                    stageBtn.type = 'button';
                    stageBtn.className = 'side-git-row-action-btn';
                    stageBtn.title = '暂存更改';
                    stageBtn.innerHTML = '<span class="vcp-ui-icon">add</span>';
                    stageBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await batchStage([item.path]);
                    });

                    const discardBtn = doc.createElement('button');
                    discardBtn.type = 'button';
                    discardBtn.className = 'side-git-row-action-btn danger';
                    discardBtn.title = '放弃更改';
                    discardBtn.innerHTML = '<span class="vcp-ui-icon">restore</span>';
                    discardBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm(`确定要放弃对 "${fileName}" 的更改吗？`)) {
                            await discardChanges([item.path]);
                        }
                    });

                    actionsWrapper.append(stageBtn, discardBtn);
                }

                // Reference to Chat
                const citeBtn = doc.createElement('button');
                citeBtn.type = 'button';
                citeBtn.className = 'side-git-row-action-btn';
                citeBtn.title = '引用此文件改动到主聊天';
                citeBtn.innerHTML = '<span class="vcp-ui-icon">push_pin</span>';
                citeBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await insertFileDiffToChat(item.path, groupKey === 'staged');
                });
                actionsWrapper.appendChild(citeBtn);

                // Diff stats
                const diffStats = doc.createElement('div');
                diffStats.className = 'side-git-diff-counts';
                const addedSpan = doc.createElement('span');
                addedSpan.className = 'text-diff-added';
                addedSpan.textContent = `+${item.added || 0}`;

                const removedSpan = doc.createElement('span');
                removedSpan.className = 'text-diff-removed';
                removedSpan.textContent = `-${item.removed || 0}`;

                diffStats.append(addedSpan, removedSpan);

                // Rotating chevron
                const chevronIcon = doc.createElement('span');
                chevronIcon.className = 'vcp-ui-icon side-git-chevron';
                chevronIcon.textContent = 'expand_more';

                metaContainer.append(actionsWrapper, diffStats, chevronIcon);
                mainRow.append(fileLabel, metaContainer);
                li.appendChild(mainRow);

                // Inline Diff Container (Collapsible)
                const diffContainer = doc.createElement('div');
                diffContainer.className = 'side-git-inline-diff';
                const isCurrentlyExpanded = expandedDiffMap.has(item.path);
                diffContainer.style.display = isCurrentlyExpanded ? 'block' : 'none';
                if (isCurrentlyExpanded) {
                    mainRow.classList.add('is-expanded');
                }
                li.appendChild(diffContainer);

                // Row click toggles inline diff
                const toggleDiff = async () => {
                    const isExpanded = diffContainer.style.display !== 'none';
                    if (isExpanded) {
                        diffContainer.style.display = 'none';
                        mainRow.classList.remove('is-expanded');
                        mainRow.setAttribute('aria-expanded', 'false');
                        expandedDiffMap.delete(item.path);
                    } else {
                        diffContainer.style.display = 'block';
                        mainRow.classList.add('is-expanded');
                        mainRow.setAttribute('aria-expanded', 'true');
                        expandedDiffMap.set(item.path, true);
                        await loadInlineDiff(item.path, groupKey === 'staged', diffContainer, addedSpan, removedSpan);
                    }
                };

                mainRow.addEventListener('click', toggleDiff);
                mainRow.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleDiff();
                    }
                });

                if (isCurrentlyExpanded) {
                    loadInlineDiff(item.path, groupKey === 'staged', diffContainer, addedSpan, removedSpan);
                }

                return li;
            }

            async function loadInlineDiff(relPath, staged, container, addedBadge, removedBadge) {
                if (!api?.gitDiff || !currentWorkspaceId) return;
                container.innerHTML = '<div class="side-git-diff-loading"><span class="vcp-ui-icon vcp-ui-spinner">progress_activity</span><span>加载差异中...</span></div>';
                try {
                    const res = await api.gitDiff(currentWorkspaceId, relPath, { staged });
                    if (!res?.success) throw new Error(res?.error || '获取差异失败');

                    const diffData = res.data;
                    if (diffData.isBinary) {
                        container.innerHTML = '<div class="side-git-diff-binary">二进制文件，无法展示文本差异</div>';
                        return;
                    }

                    const lcs = computeLineDiff(diffData.before || '', diffData.after || '');
                    container.innerHTML = '';

                    // Update row counters if available
                    if (addedBadge && removedBadge) {
                        addedBadge.textContent = `+${lcs.addedCount}`;
                        removedBadge.textContent = `-${lcs.deletedCount}`;
                    }

                    // Diff Toolbar Header
                    const diffHeader = doc.createElement('div');
                    diffHeader.className = 'side-git-diff-summary-bar';
                    diffHeader.innerHTML = `
                        <div class="diff-summary-stats">
                            <span class="diff-stat-add">+${lcs.addedCount}</span>
                            <span class="diff-stat-del">-${lcs.deletedCount}</span>
                            <span class="diff-stat-rows">${lcs.rows.length} 行对比</span>
                        </div>
                        <div class="side-git-diff-actions">
                            <button type="button" class="side-git-diff-btn cite-chat" title="引用此差异到主聊天">
                                <span class="vcp-ui-icon">push_pin</span>
                                <span>引用</span>
                            </button>
                            <button type="button" class="side-git-diff-btn open-subscreen" title="在代码副屏中展开完整查看">
                                <span class="vcp-ui-icon">open_in_new</span>
                                <span>代码副屏</span>
                            </button>
                        </div>
                    `;

                    // Wire action buttons
                    const citeBtn = diffHeader.querySelector('.cite-chat');
                    citeBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        insertFileDiffToChat(relPath, staged);
                    });

                    const openSubscreenBtn = diffHeader.querySelector('.open-subscreen');
                    openSubscreenBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (typeof onOpenCodeViewer === 'function') {
                            onOpenCodeViewer({
                                filePath: relPath,
                                mode: 'diff',
                                oldCode: diffData.before || '',
                                newCode: diffData.after || '',
                                title: `${relPath} (Diff)`
                            });
                        } else {
                            uiHelper?.showToastNotification?.('已在代码副屏打开', 'info');
                        }
                    });

                    const table = doc.createElement('table');
                    table.className = 'side-git-diff-table';

                    // Render max 200 diff lines in subscreen to prevent heavy layout lags
                    const previewRows = lcs.rows.slice(0, 200);
                    previewRows.forEach(row => {
                        const tr = doc.createElement('tr');
                        tr.className = `diff-line ${row.type}`;

                        const oldNum = doc.createElement('td');
                        oldNum.className = 'diff-num';
                        oldNum.textContent = row.oldLine !== null ? String(row.oldLine) : '';

                        const newNum = doc.createElement('td');
                        newNum.className = 'diff-num';
                        newNum.textContent = row.newLine !== null ? String(row.newLine) : '';

                        const content = doc.createElement('td');
                        content.className = 'diff-content';
                        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
                        content.textContent = `${sign} ${row.text}`;

                        tr.append(oldNum, newNum, content);
                        table.appendChild(tr);
                    });

                    container.append(diffHeader, table);

                    if (lcs.rows.length > 200) {
                        const overflowNotice = doc.createElement('div');
                        overflowNotice.className = 'side-git-diff-overflow';
                        overflowNotice.textContent = `... 更多 ${lcs.rows.length - 200} 行差异已省略 (点击上方"代码副屏"查看完整内容)`;
                        container.appendChild(overflowNotice);
                    }
                } catch (err) {
                    container.innerHTML = `<div class="side-git-diff-error">${escapeHtml(err.message)}</div>`;
                }
            }

            async function batchStage(paths) {
                if (!api?.gitStage || !currentWorkspaceId || paths.length === 0) return;
                try {
                    const res = await api.gitStage(currentWorkspaceId, paths);
                    if (!res?.success) throw new Error(res?.error || '暂存失败');
                    await refreshStatus({ quiet: true });
                } catch (err) {
                    showNotice(err.message, 'error');
                }
            }

            async function batchUnstage(paths) {
                if (!api?.gitUnstage || !currentWorkspaceId || paths.length === 0) return;
                try {
                    const res = await api.gitUnstage(currentWorkspaceId, paths);
                    if (!res?.success) throw new Error(res?.error || '取消暂存失败');
                    await refreshStatus({ quiet: true });
                } catch (err) {
                    showNotice(err.message, 'error');
                }
            }

            async function discardChanges(paths) {
                if (!api?.gitDiscard || !currentWorkspaceId || paths.length === 0) return;
                try {
                    const res = await api.gitDiscard(currentWorkspaceId, paths);
                    if (!res?.success) throw new Error(res?.error || '放弃更改失败');
                    paths.forEach(p => expandedDiffMap.delete(p));
                    await refreshStatus({ quiet: true });
                    showNotice('已放弃文件更改并移入回收站', 'info');
                } catch (err) {
                    showNotice(err.message, 'error');
                }
            }

            async function insertFileDiffToChat(relPath, staged) {
                try {
                    const res = await api.gitDiff(currentWorkspaceId, relPath, { staged });
                    if (!res?.success) throw new Error(res?.error || '获取差异失败');

                    const diffData = res.data;
                    const diffText = diffData.rawDiff || `[文件改动: ${relPath}]`;
                    const snippet = `\`\`\`diff\n# 工作区文件改动: ${relPath}\n${diffText.slice(0, 1500)}\n\`\`\``;

                    const messageInput = doc.getElementById('messageInput');
                    if (messageInput) {
                        const currentVal = messageInput.value;
                        messageInput.value = currentVal ? `${currentVal}\n\n${snippet}` : snippet;
                        messageInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
                        messageInput.focus();
                        uiHelper?.showToastNotification?.(`已将 "${relPath}" 改动代码引用填入输入框`, 'success');
                    }
                } catch (err) {
                    showNotice('引用失败: ' + err.message, 'error');
                }
            }

            async function handleCommit() {
                const message = commitInput.value.trim();
                if (!message) {
                    showNotice('请输入提交信息', 'error');
                    commitInput.focus();
                    return;
                }
                if (!api?.gitCommit || !currentWorkspaceId) return;

                commitBtn.disabled = true;
                commitBtn.innerHTML = '<span class="vcp-ui-icon vcp-ui-spinner">progress_activity</span><span>提交中</span>';
                try {
                    const res = await api.gitCommit(currentWorkspaceId, { message });
                    if (!res?.success) throw new Error(res?.error || '提交失败');
                    commitInput.value = '';
                    showNotice('✓ 提交成功', 'success');
                    expandedDiffMap.clear();
                    await refreshStatus({ quiet: true });
                } catch (err) {
                    showNotice(err.message, 'error');
                } finally {
                    commitBtn.disabled = false;
                    commitBtn.innerHTML = '<span class="vcp-ui-icon">check</span><span>提交</span>';
                }
            }

            async function handlePush() {
                if (!api?.gitPush || !currentWorkspaceId) return;

                pushBtn.disabled = true;
                pushBtn.innerHTML = '<span class="vcp-ui-icon vcp-ui-spinner">progress_activity</span><span>推送中</span>';
                try {
                    const res = await api.gitPush(currentWorkspaceId, {});
                    if (!res?.success) throw new Error(res?.error || '推送失败');
                    showNotice('✓ 远程推送成功', 'success');
                    await refreshStatus({ quiet: true });
                } catch (err) {
                    showNotice(err.message, 'error');
                } finally {
                    pushBtn.disabled = false;
                    pushBtn.innerHTML = '<span class="vcp-ui-icon">upload</span><span>推送</span>';
                }
            }

            // Bind Top Source Select
            sourceSelect.addEventListener('change', () => {
                currentSource = sourceSelect.value;
                storage?.setItem(STORAGE_KEY_SOURCE, currentSource);
                if (currentStatus) renderStatus(currentStatus);
            });

            // Bind Workspace Select
            wsSelect.addEventListener('change', () => {
                currentWorkspaceId = wsSelect.value;
                storage?.setItem(STORAGE_KEY_WS, currentWorkspaceId);
                expandedDiffMap.clear();
                refreshStatus({ quiet: false });
            });

            refreshBtn.addEventListener('click', () => refreshStatus({ quiet: false }));

            fullWindowBtn.addEventListener('click', () => {
                if (typeof onOpenProjectForge === 'function') {
                    onOpenProjectForge();
                } else if (api?.desktopCreateEmbeddedVchatApp) {
                    api.desktopCreateEmbeddedVchatApp('open-project-forge-window');
                }
            });

            commitBtn.addEventListener('click', handleCommit);
            pushBtn.addEventListener('click', handlePush);

            commitInput.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleCommit();
                }
            });

            // Start Polling Loop
            function startPolling() {
                if (pollTimer) clearInterval(pollTimer);
                pollTimer = setInterval(() => {
                    if (!isDisposed && viewElement.offsetParent !== null) {
                        refreshStatus({ quiet: true });
                    }
                }, POLL_INTERVAL_MS);
            }

            // Initial Load
            await loadWorkspaces();
            startPolling();

            return {
                focus() {
                    commitInput?.focus?.();
                },
                refresh() {
                    return refreshStatus({ quiet: false });
                },
                async dispose() {
                    isDisposed = true;
                    if (pollTimer) clearInterval(pollTimer);
                    pollTimer = null;
                }
            };
        }
    });
}
