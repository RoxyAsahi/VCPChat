/* Host controller for Workspace Side Pane, managing tabs, views, and provider lifecycles. */
'use strict';

import * as SidePaneState from './side-pane-state.js';
import { createSidePaneResizerOwner } from './side-pane-resizer-owner.js';

export function createSidePaneController({
    root,
    resizerHandle,
    tabListElement,
    contentContainer,
    toggleNotificationsBtn = null,
    toggleChatBtn = null,
    closeSidePaneBtn = null,
    addChatTabBtn = null,
    overviewBtn = null,
    overviewPopover = null,
    settingsRef = null,
    electronAPI = null,
    scope = null,
    providers = {},
    onOpenSideChat = null,
    onTabClosed = null,
    onRestoreSessions = null
}) {
    if (!root) {
        throw new TypeError('SidePaneController requires a root element');
    }

    const doc = root.ownerDocument || globalThis.document;
    const resolvedAddChatTabBtn = addChatTabBtn || doc.getElementById?.('addSidePaneChatBtn');
    const resolvedOverviewBtn = overviewBtn || doc.getElementById?.('sidePaneTabOverviewBtn');
    const resolvedOverviewPopover = overviewPopover || doc.getElementById?.('sidePaneTabOverviewPopover');
    const resolvedAddMenuPopover = doc.getElementById?.('sidePaneAddMenuPopover');
    const resolvedTabContextMenu = doc.getElementById?.('sidePaneTabContextMenu');

    const initialWidth = Number(settingsRef?.get?.()?.notificationsSidebarWidth)
        || SidePaneState.DEFAULT_WIDTH;

    let state = SidePaneState.createInitialSidePaneState({
        preferredWidth: initialWidth,
        visible: root.classList.contains('active') || root.getAttribute('aria-hidden') === 'false'
    });

    const mountedTabMap = new Map(); // tabId -> { provider, viewElement, tabElement, handle }
    const pendingMountMap = new Map(); // childKey -> Promise<handle>
    const childDraftsMap = new Map(); // childKey -> { draft: string, references: Array }
    const cleanupListeners = [];
    const recentlyClosedTabs = [];
    const collapsedByParent = new Map(); // parentKey -> boolean
    const activeTabByParent = new Map(); // parentKey -> tabId
    let isDisposed = false;
    let contextTargetTabId = null;

    // Resizer Owner
    let resizerOwner = null;
    if (resizerHandle && typeof window !== 'undefined' && window.VCPSidebarResizer?.create) {
        resizerOwner = createSidePaneResizerOwner({
            handle: resizerHandle,
            paneElement: root,
            onWidthChange: (width) => {
                state = SidePaneState.setPreferredWidth(state, width);
            },
            onWidthCommit: async (width) => {
                state = SidePaneState.setPreferredWidth(state, width);
                if (settingsRef?.set) {
                    const current = settingsRef.get() || {};
                    settingsRef.set({ ...current, notificationsSidebarWidth: width });
                }
                if (electronAPI?.saveSettings) {
                    try {
                        const ops = [{ op: 'set', path: ['notificationsSidebarWidth'], value: width }];
                        await electronAPI.saveSettings({ __vcpSettingsOps: ops });
                    } catch (err) {
                        console.error('[SidePaneController] Failed to persist width:', err);
                    }
                }
            },
            scope
        });
    }

    function renderTabList() {
        if (!tabListElement) return;
        tabListElement.innerHTML = '';
        tabListElement.setAttribute('role', 'tablist');
        tabListElement.setAttribute('aria-label', '工作区侧栏标签页');

        const visibleTabs = SidePaneState.getVisibleTabs(state, state.parent);

        visibleTabs.forEach(tab => {
            const isActive = tab.id === state.activeTabId;

            const tabItem = doc.createElement('div');
            tabItem.className = `side-pane-tab-item${isActive ? ' active' : ''}`;
            tabItem.setAttribute('data-tab-id', tab.id);

            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = `side-pane-tab${isActive ? ' active' : ''}`;
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
            btn.setAttribute('data-tab-id', tab.id);

            const iconSpan = doc.createElement('span');
            iconSpan.className = 'tab-icon vcp-ui-icon';
            iconSpan.setAttribute('aria-hidden', 'true');
            iconSpan.textContent = tab.kind === 'notifications' ? 'notifications' : 'chat_bubble';

            const titleSpan = doc.createElement('span');
            titleSpan.className = 'tab-title';
            titleSpan.textContent = tab.title;

            btn.append(iconSpan, titleSpan);

            btn.addEventListener('click', () => {
                controller.activateTab(tab.id);
            });

            tabItem.appendChild(btn);

            // Close button for closable tabs (chat tabs) - sibling to tab button
            if (tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID) {
                const closeBtn = doc.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'side-pane-tab-close';
                closeBtn.title = '关闭此侧聊';
                closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
                closeBtn.setAttribute('tabindex', '-1');
                closeBtn.innerHTML = '<span class="vcp-ui-icon" style="font-size:12px;">close</span>';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    controller.closeTab(tab.id);
                });
                tabItem.appendChild(closeBtn);
            }

            tabItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                hideAddMenu();
                showTabContextMenu(tab.id, e.clientX, e.clientY);
            });

            tabListElement.appendChild(tabItem);
        });
        renderTabOverviewPopover?.(searchInput?.value || '');
    }

    if (tabListElement) {
        tabListElement.addEventListener('keydown', (e) => {
            const tabButtons = Array.from(tabListElement.querySelectorAll('[role="tab"]'));
            if (tabButtons.length === 0) return;
            const currentIndex = tabButtons.findIndex(b => b.getAttribute('data-tab-id') === state.activeTabId);
            let targetIndex = currentIndex;

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                targetIndex = (currentIndex + 1) % tabButtons.length;
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                targetIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
            } else if (e.key === 'Home') {
                e.preventDefault();
                targetIndex = 0;
            } else if (e.key === 'End') {
                e.preventDefault();
                targetIndex = tabButtons.length - 1;
            }

            if (targetIndex !== currentIndex && targetIndex >= 0 && targetIndex < tabButtons.length) {
                const targetId = tabButtons[targetIndex].getAttribute('data-tab-id');
                controller.activateTab(targetId);
                tabButtons[targetIndex].focus();
            }
        });
    }

    function syncViewPanels() {
        if (!contentContainer) return;
        const visibleTabs = SidePaneState.getVisibleTabs(state, state.parent);
        const visibleTabIds = new Set(visibleTabs.map(t => t.id));
        if (state.activeTabId === SidePaneState.LAUNCHER_TAB_ID) {
            visibleTabIds.add(SidePaneState.LAUNCHER_TAB_ID);
        }
        const views = contentContainer.querySelectorAll('.side-pane-view');
        views.forEach(view => {
            const viewTabId = view.getAttribute('data-tab-id') || (
                view.id === 'sidePaneViewNotifications' ? SidePaneState.NOTIFICATIONS_TAB_ID : (
                    view.id === 'sidePaneViewLauncher' ? SidePaneState.LAUNCHER_TAB_ID : null
                )
            );
            const isVisible = visibleTabIds.has(viewTabId) || (viewTabId === SidePaneState.LAUNCHER_TAB_ID && state.activeTabId === SidePaneState.LAUNCHER_TAB_ID);
            const isActive = isVisible && viewTabId === state.activeTabId;
            view.classList.toggle('active', isActive);
            view.setAttribute('aria-hidden', String(!isActive));
            if (!isVisible || !isActive) {
                view.style.display = 'none';
            } else {
                view.style.display = '';
            }
        });
    }

    function syncDomVisibility() {
        const isVisible = state.visible;
        root.classList.toggle('active', isVisible);
        root.classList.toggle('collapsed', !isVisible);
        root.setAttribute('aria-hidden', String(!isVisible));

        if (resizerHandle) {
            resizerHandle.classList.toggle('hidden', !isVisible);
        }

        const mainContent = doc.querySelector('.main-content');
        if (mainContent) {
            mainContent.classList.toggle('notifications-sidebar-active', isVisible);
            mainContent.classList.toggle('side-pane-active', isVisible);
        }

        if (isVisible) {
            root.style.width = `${state.preferredWidth}px`;
        }

        if (toggleNotificationsBtn) {
            const isNotifActive = isVisible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID;
            toggleNotificationsBtn.classList.toggle('notification-panel-active', isNotifActive);
            toggleNotificationsBtn.setAttribute('aria-expanded', String(isNotifActive));
        }

        const notifSidebar = doc.getElementById('notificationsSidebar');
        if (notifSidebar) {
            const isNotifActive = isVisible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID;
            notifSidebar.classList.toggle('active', isNotifActive);
        }

        if (toggleChatBtn) {
            const isChatActive = isVisible && state.activeTabId !== SidePaneState.NOTIFICATIONS_TAB_ID && state.activeTabId !== SidePaneState.LAUNCHER_TAB_ID;
            toggleChatBtn.classList.toggle('side-chat-active', isChatActive);
            toggleChatBtn.setAttribute('aria-expanded', String(isChatActive));
        }
    }

    const controller = Object.freeze({
        getSnapshot() {
            return state;
        },

        setVisible(visible) {
            if (isDisposed) return;
            state = SidePaneState.setVisible(state, visible);
            if (state.parent) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                collapsedByParent.set(parentKey, !state.visible);
            }
            syncDomVisibility();
            if (!visible) {
                const trigger = toggleChatBtn || toggleNotificationsBtn || doc.getElementById('toggleSidePaneChatBtn') || doc.getElementById('closeSidePaneBtn');
                trigger?.focus?.();
            }
        },

        toggleVisible() {
            if (isDisposed) return;
            this.setVisible(!state.visible);
        },

        showNotifications() {
            if (isDisposed) return;
            state = SidePaneState.showNotifications(state);
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        showLauncher() {
            if (isDisposed) return;
            state = SidePaneState.showLauncher(state);
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        activateTab(tabId) {
            if (isDisposed || !tabId) return;
            state = SidePaneState.activateTab(state, tabId);
            if (state.parent && tabId !== SidePaneState.NOTIFICATIONS_TAB_ID && tabId !== SidePaneState.LAUNCHER_TAB_ID) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                activeTabByParent.set(parentKey, tabId);
                if (state.visible) {
                    collapsedByParent.set(parentKey, false);
                }
            }
            renderTabList();
            syncViewPanels();
            syncDomVisibility();

            const entry = mountedTabMap.get(tabId);
            entry?.handle?.focus?.();
        },

        async closeOtherTabs(tabId) {
            if (isDisposed || !tabId) return;
            const chatTabs = state.tabs.filter(t => t.kind === 'chat' && t.id !== tabId);
            for (const tab of chatTabs) {
                await this.closeTab(tab.id);
            }
            this.activateTab(tabId);
        },

        async closeAllTabs() {
            if (isDisposed) return;
            const chatTabs = state.tabs.filter(t => t.kind === 'chat');
            for (const tab of chatTabs) {
                await this.closeTab(tab.id);
            }
            this.showLauncher();
        },

        async openChat(descriptor) {
            if (isDisposed || !descriptor) return null;
            const childKey = `${descriptor.child?.itemId || ''}:${descriptor.child?.topicId || descriptor.id}`;
            if (pendingMountMap.has(childKey)) {
                return await pendingMountMap.get(childKey);
            }

            const mountPromise = (async () => {
                state = SidePaneState.openChatTab(state, descriptor);
                const targetTabId = state.activeTabId;
                if (state.parent && SidePaneState.matchesConversation(descriptor.parent, state.parent)) {
                    const parentKey = SidePaneState.getParentKey(state.parent);
                    collapsedByParent.set(parentKey, false);
                    activeTabByParent.set(parentKey, targetTabId);
                }
                renderTabList();

                // Check if view container already mounted for this tab
                let entry = mountedTabMap.get(targetTabId);
                if (!entry) {
                    let view = contentContainer?.querySelector(`[data-tab-id="${targetTabId}"]`);
                    if (!view && contentContainer) {
                        view = doc.createElement('section');
                        view.className = 'side-pane-view';
                        view.setAttribute('data-tab-id', targetTabId);
                        view.setAttribute('role', 'tabpanel');
                        contentContainer.appendChild(view);
                    }

                    if (providers.chat?.mountTab && view) {
                        const handle = await providers.chat.mountTab(descriptor, view);
                        if (isDisposed || !state.tabs.some(t => t.id === targetTabId)) {
                            await handle?.dispose?.();
                            view?.remove?.();
                            return null;
                        }
                        entry = { descriptor, viewElement: view, handle };
                        mountedTabMap.set(targetTabId, entry);

                        // Restore cached draft & uncommitted references if available
                        if (childDraftsMap.has(childKey)) {
                            const cached = childDraftsMap.get(childKey);
                            childDraftsMap.delete(childKey);
                            if (cached.draft && typeof handle?.setDraft === 'function') {
                                handle.setDraft(cached.draft);
                            }
                            if (Array.isArray(cached.references) && typeof handle?.addReference === 'function') {
                                cached.references.forEach(r => handle.addReference(r));
                            }
                        } else if (descriptor?.draft || (Array.isArray(descriptor?.references) && descriptor.references.length > 0)) {
                            if (descriptor.draft && typeof handle?.setDraft === 'function') {
                                handle.setDraft(descriptor.draft);
                            }
                            if (Array.isArray(descriptor.references) && typeof handle?.addReference === 'function') {
                                descriptor.references.forEach(r => handle.addReference(r));
                            }
                        }
                        if (descriptor?.model && typeof handle?.setModel === 'function' && handle.getModel?.() !== descriptor.model) {
                            handle.setModel(descriptor.model);
                        }
                    } else if (view) {
                        if (isDisposed || !state.tabs.some(t => t.id === targetTabId)) {
                            view?.remove?.();
                            return null;
                        }
                        entry = { descriptor, viewElement: view, handle: null };
                        mountedTabMap.set(targetTabId, entry);
                    }
                }

                syncViewPanels();
                syncDomVisibility();
                entry?.handle?.focus?.();
                return entry?.handle || null;
            })();

            pendingMountMap.set(childKey, mountPromise);
            try {
                return await mountPromise;
            } finally {
                pendingMountMap.delete(childKey);
            }
        },

        getTabHandle(tabId) {
            if (isDisposed || !tabId) return null;
            return mountedTabMap.get(tabId)?.handle || null;
        },

        registerProvider(name, provider) {
            if (isDisposed) return;
            providers[name] = provider;
        },

        async closeTab(tabId) {
            if (isDisposed || !tabId || tabId === SidePaneState.NOTIFICATIONS_TAB_ID) return;
            const entry = mountedTabMap.get(tabId);
            const tabDesc = entry?.descriptor || state.tabs.find(t => t.id === tabId)?.descriptor || null;
            let updatedTabDesc = tabDesc ? { ...tabDesc } : null;
            if (entry) {
                // Preserve model, draft & uncommitted references before closing
                const childKey = `${tabDesc?.child?.itemId || ''}:${tabDesc?.child?.topicId || tabDesc?.id || tabId}`;
                const draft = entry.handle?.getDraft?.() || '';
                const refs = entry.handle?.getReferences?.() || [];
                const latestModel = entry.handle?.getModel?.();
                if (latestModel && updatedTabDesc) {
                    updatedTabDesc.model = latestModel;
                }
                if (draft || refs.length > 0) {
                    childDraftsMap.set(childKey, { draft, references: refs });
                }
                if (updatedTabDesc) {
                    updatedTabDesc.draft = draft;
                    updatedTabDesc.references = refs;
                }

                const closeResult = await entry.handle?.requestClose?.();
                if (closeResult && closeResult.closed === false) {
                    return; // User or operation prevented close
                }
                await entry.handle?.dispose?.();
                entry.viewElement?.remove?.();
                mountedTabMap.delete(tabId);
            }
            if (updatedTabDesc && typeof onTabClosed === 'function') {
                try { await onTabClosed(updatedTabDesc); } catch {}
            }

            const tabObj = state.tabs.find(t => t.id === tabId);
            // ZCode parity (useAppPanels.ts:1334):
            // Ephemeral secondary sessions (selection-side-chat / kind === 'chat') are explicitly
            // excluded from recentlyClosedTabs.
            const isEphemeralChat = tabObj?.kind === 'chat' || tabObj?.type === 'selection-side-chat' || updatedTabDesc?.ephemeral;
            if (tabObj && !isEphemeralChat && updatedTabDesc) {
                recentlyClosedTabs.unshift({
                    id: tabId,
                    title: tabObj.title || updatedTabDesc.title || '标签页',
                    descriptor: updatedTabDesc,
                    closedAt: Date.now()
                });
                if (recentlyClosedTabs.length > 10) {
                    recentlyClosedTabs.pop();
                }
            }

            state = SidePaneState.closeTab(state, tabId);

            // ZCode parity (useAppPanels.ts:309-318 syncSidePaneCollapsedWithTabs):
            // When all visible chat tabs for current parent are closed, automatically collapse side pane.
            const remainingCurrentTabs = state.parent
                ? state.tabs.filter(t => t.kind === 'chat' && t.descriptor && SidePaneState.matchesConversation(t.descriptor.parent, state.parent))
                : [];
            if (remainingCurrentTabs.length === 0) {
                state = SidePaneState.setVisible(state, false);
                if (state.parent) {
                    const parentKey = SidePaneState.getParentKey(state.parent);
                    collapsedByParent.set(parentKey, true);
                    activeTabByParent.delete(parentKey);
                }
            } else if (state.parent) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                if (activeTabByParent.get(parentKey) === tabId) {
                    activeTabByParent.set(parentKey, state.activeTabId);
                }
            }

            renderTabList();
            syncViewPanels();
            syncDomVisibility();
            const activeTabBtn = tabListElement?.querySelector?.(`[role="tab"][data-tab-id="${state.activeTabId}"]`);
            activeTabBtn?.focus?.();
        },

        setParent(parentRef) {
            if (isDisposed) return;
            // Persist current parent's active tab and collapsed state before switching
            if (state.parent) {
                const prevKey = SidePaneState.getParentKey(state.parent);
                if (state.activeTabId && state.activeTabId !== SidePaneState.NOTIFICATIONS_TAB_ID && state.activeTabId !== SidePaneState.LAUNCHER_TAB_ID) {
                    activeTabByParent.set(prevKey, state.activeTabId);
                }
                collapsedByParent.set(prevKey, !state.visible);
            }

            const nextKey = parentRef ? SidePaneState.getParentKey(parentRef) : '';
            const preferredTabId = activeTabByParent.get(nextKey);
            const collapsedPreference = collapsedByParent.get(nextKey);

            state = SidePaneState.setParent(state, parentRef, { preferredTabId, collapsedPreference });
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        setPreferredWidth(width) {
            if (isDisposed) return;
            state = SidePaneState.setPreferredWidth(state, width);
            if (state.visible) {
                root.style.width = `${state.preferredWidth}px`;
            }
        },

        async openSideChat(opts = {}) {
            if (isDisposed) return null;
            if (typeof onOpenSideChat === 'function') {
                return await onOpenSideChat(opts);
            }
            return null;
        },

        async restoreSessions(agentId, parentTopicId) {
            if (isDisposed || !agentId) return [];
            if (typeof onRestoreSessions === 'function') {
                return await onRestoreSessions(agentId, parentTopicId);
            }
            return [];
        },

        async dispose() {
            if (isDisposed) return;
            isDisposed = true;
            cleanupListeners.forEach(cleanup => cleanup());
            cleanupListeners.length = 0;

            resizerOwner?.dispose?.();

            const disposePromises = [];
            mountedTabMap.forEach((entry) => {
                if (entry.handle?.dispose) {
                    disposePromises.push(entry.handle.dispose());
                }
                entry.viewElement?.remove?.();
            });
            mountedTabMap.clear();
            await Promise.allSettled(disposePromises);
        }
    });

    // Wire up buttons
    if (toggleNotificationsBtn && !electronAPI?.sendToggleNotificationsSidebar) {
        const onNotifClick = () => {
            if (state.visible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID) {
                controller.setVisible(false);
            } else {
                controller.showNotifications();
            }
        };
        toggleNotificationsBtn.addEventListener('click', onNotifClick);
        cleanupListeners.push(() => toggleNotificationsBtn.removeEventListener('click', onNotifClick));
    }

    if (toggleChatBtn) {
        const onChatClick = () => {
            if (state.visible && state.activeTabId !== SidePaneState.NOTIFICATIONS_TAB_ID) {
                controller.setVisible(false);
            } else {
                const currentParentChatTabs = state.parent
                    ? state.tabs.filter(t => t.kind === 'chat' && t.descriptor && SidePaneState.matchesConversation(t.descriptor.parent, state.parent))
                    : state.tabs.filter(t => t.kind === 'chat');
                if (currentParentChatTabs.length > 0) {
                    const parentKey = state.parent ? SidePaneState.getParentKey(state.parent) : '';
                    const prefTab = parentKey ? activeTabByParent.get(parentKey) : null;
                    const targetId = prefTab && currentParentChatTabs.some(t => t.id === prefTab)
                        ? prefTab
                        : currentParentChatTabs[currentParentChatTabs.length - 1].id;
                    controller.activateTab(targetId);
                    controller.setVisible(true);
                } else if (typeof onOpenSideChat === 'function') {
                    onOpenSideChat();
                }
            }
        };
        toggleChatBtn.addEventListener('click', onChatClick);
        cleanupListeners.push(() => toggleChatBtn.removeEventListener('click', onChatClick));
    }

    if (closeSidePaneBtn) {
        const onCloseClick = () => controller.setVisible(false);
        closeSidePaneBtn.addEventListener('click', onCloseClick);
        cleanupListeners.push(() => closeSidePaneBtn.removeEventListener('click', onCloseClick));
    }

    function formatRelativeTime(timestamp) {
        const diff = Math.max(0, Date.now() - timestamp);
        if (diff < 60_000) return '刚刚';
        const mins = Math.floor(diff / 60_000);
        if (mins < 60) return `${mins}分钟前`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}小时前`;
        return `${Math.floor(hours / 24)}天前`;
    }

    function renderTabOverviewPopover(filterQuery = '') {
        if (!resolvedOverviewPopover) return;
        const listEl = resolvedOverviewPopover.querySelector('#sidePaneOpenTabsList');
        if (!listEl) return;
        listEl.innerHTML = '';
        const visibleTabs = SidePaneState.getVisibleTabs(state, state.parent);
        const query = filterQuery.trim().toLowerCase();
        const filteredOpen = query
            ? visibleTabs.filter(t => t.title.toLowerCase().includes(query))
            : visibleTabs;
        const filteredClosed = query
            ? recentlyClosedTabs.filter(t => t.title.toLowerCase().includes(query))
            : recentlyClosedTabs;

        if (filteredOpen.length === 0 && filteredClosed.length === 0) {
            const emptyEl = doc.createElement('div');
            emptyEl.className = 'side-pane-overview-empty';
            emptyEl.textContent = '未找到匹配的标签页';
            listEl.appendChild(emptyEl);
            return;
        }

        if (filteredOpen.length > 0) {
            const openTitle = doc.createElement('div');
            openTitle.className = 'side-pane-overview-section-title';
            openTitle.textContent = '打开的标签页';
            listEl.appendChild(openTitle);

            filteredOpen.forEach(tab => {
                const item = doc.createElement('div');
                item.className = `side-pane-overview-item${tab.id === state.activeTabId ? ' active' : ''}`;
                const titleDiv = doc.createElement('div');
                titleDiv.className = 'side-pane-overview-item-title';
                const icon = doc.createElement('span');
                icon.className = 'vcp-ui-icon';
                icon.style.fontSize = '14px';
                icon.textContent = tab.kind === 'notifications' ? 'notifications' : 'chat_bubble';
                const label = doc.createElement('span');
                label.textContent = tab.title;
                titleDiv.append(icon, label);

                item.appendChild(titleDiv);

                if (tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID) {
                    const closeBtn = doc.createElement('button');
                    closeBtn.type = 'button';
                    closeBtn.className = 'side-pane-tab-close';
                    closeBtn.title = '关闭';
                    closeBtn.innerHTML = '<span class="vcp-ui-icon" style="font-size:12px;">close</span>';
                    closeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        controller.closeTab(tab.id);
                        renderTabOverviewPopover(searchInput?.value || '');
                    });
                    item.appendChild(closeBtn);
                }

                item.addEventListener('click', () => {
                    controller.activateTab(tab.id);
                    controller.setVisible(true);
                    resolvedOverviewPopover.style.display = 'none';
                });

                listEl.appendChild(item);
            });
        }

        if (filteredClosed.length > 0) {
            const closedTitle = doc.createElement('div');
            closedTitle.className = 'side-pane-overview-section-title';
            closedTitle.textContent = '最近关闭的标签页';
            listEl.appendChild(closedTitle);

            filteredClosed.forEach((closedTab) => {
                const item = doc.createElement('div');
                item.className = 'side-pane-overview-item recently-closed';

                const titleDiv = doc.createElement('div');
                titleDiv.className = 'side-pane-overview-item-title';
                const icon = doc.createElement('span');
                icon.className = 'vcp-ui-icon';
                icon.style.fontSize = '14px';
                icon.textContent = 'history';
                const label = doc.createElement('span');
                label.textContent = closedTab.title;
                titleDiv.append(icon, label);

                const timeSpan = doc.createElement('span');
                timeSpan.className = 'side-pane-overview-time';
                timeSpan.textContent = formatRelativeTime(closedTab.closedAt);

                item.append(titleDiv, timeSpan);

                item.addEventListener('click', async () => {
                    resolvedOverviewPopover.style.display = 'none';
                    let opened = null;
                    if (typeof onOpenSideChat === 'function') {
                        opened = await onOpenSideChat(closedTab.descriptor);
                    } else {
                        opened = await controller.openChat(closedTab.descriptor);
                    }
                    if (opened) {
                        const idx = recentlyClosedTabs.indexOf(closedTab);
                        if (idx !== -1) recentlyClosedTabs.splice(idx, 1);
                    }
                    controller.setVisible(true);
                });

                listEl.appendChild(item);
            });
        }
    }

    const searchInput = resolvedOverviewPopover?.querySelector?.('.side-pane-overview-input');
    if (searchInput) {
        const onSearchInput = () => {
            renderTabOverviewPopover(searchInput.value);
        };
        searchInput.addEventListener('input', onSearchInput);
        cleanupListeners.push(() => searchInput.removeEventListener('input', onSearchInput));
    }

    if (resolvedOverviewBtn && resolvedOverviewPopover) {
        const onOverviewClick = (e) => {
            e.stopPropagation();
            const isOpen = resolvedOverviewPopover.style.display !== 'none';
            resolvedOverviewPopover.style.display = isOpen ? 'none' : 'flex';
            if (!isOpen) {
                if (searchInput) searchInput.value = '';
                renderTabOverviewPopover();
                searchInput?.focus?.();
            }
        };
        resolvedOverviewBtn.addEventListener('click', onOverviewClick);
        cleanupListeners.push(() => resolvedOverviewBtn.removeEventListener('click', onOverviewClick));

        const onDocClick = (e) => {
            if (!resolvedOverviewPopover.contains?.(e.target) && e.target !== resolvedOverviewBtn) {
                resolvedOverviewPopover.style.display = 'none';
            }
            if (!resolvedAddMenuPopover?.contains?.(e.target) && !resolvedAddChatTabBtn?.contains?.(e.target)) {
                hideAddMenu();
            }
            if (!resolvedTabContextMenu?.contains?.(e.target)) {
                hideTabContextMenu();
            }
        };
        doc.addEventListener('click', onDocClick);
        cleanupListeners.push(() => doc.removeEventListener('click', onDocClick));
    }

    function showTabContextMenu(tabId, x, y) {
        if (!resolvedTabContextMenu) return;
        contextTargetTabId = tabId;
        resolvedTabContextMenu.style.display = 'flex';
        resolvedTabContextMenu.style.position = 'fixed';
        const winWidth = doc.defaultView?.innerWidth || 1000;
        const winHeight = doc.defaultView?.innerHeight || 800;
        resolvedTabContextMenu.style.left = `${Math.min(x, winWidth - 180)}px`;
        resolvedTabContextMenu.style.top = `${Math.min(y, winHeight - 150)}px`;
        resolvedTabContextMenu.style.zIndex = '1000';

        const closeCurrentBtn = resolvedTabContextMenu.querySelector('[data-action="close-tab"]');
        if (closeCurrentBtn) {
            const canClose = tabId !== SidePaneState.NOTIFICATIONS_TAB_ID;
            closeCurrentBtn.disabled = !canClose;
            closeCurrentBtn.style.opacity = canClose ? '1' : '0.4';
        }

        const closeOthersBtn = resolvedTabContextMenu.querySelector('[data-action="close-others"]');
        if (closeOthersBtn) {
            const hasOthers = state.tabs.some(t => t.kind === 'chat' && t.id !== tabId);
            closeOthersBtn.disabled = !hasOthers;
            closeOthersBtn.style.opacity = hasOthers ? '1' : '0.4';
        }

        const closeAllBtn = resolvedTabContextMenu.querySelector('[data-action="close-all"]');
        if (closeAllBtn) {
            const hasChats = state.tabs.some(t => t.kind === 'chat');
            closeAllBtn.disabled = !hasChats;
            closeAllBtn.style.opacity = hasChats ? '1' : '0.4';
        }
    }

    function hideTabContextMenu() {
        if (resolvedTabContextMenu) {
            resolvedTabContextMenu.style.display = 'none';
            contextTargetTabId = null;
        }
    }

    function hideAddMenu() {
        if (resolvedAddMenuPopover) {
            resolvedAddMenuPopover.style.display = 'none';
        }
    }

    if (resolvedTabContextMenu) {
        const onContextMenuClick = async (e) => {
            const actionBtn = e.target.closest('[data-action]');
            if (!actionBtn || actionBtn.disabled) return;
            const action = actionBtn.getAttribute('data-action');
            const targetId = contextTargetTabId;
            hideTabContextMenu();

            if (action === 'close-tab' && targetId) {
                await controller.closeTab(targetId);
            } else if (action === 'close-others' && targetId) {
                await controller.closeOtherTabs(targetId);
            } else if (action === 'close-all') {
                await controller.closeAllTabs();
            }
        };
        resolvedTabContextMenu.addEventListener('click', onContextMenuClick);
        cleanupListeners.push(() => resolvedTabContextMenu.removeEventListener('click', onContextMenuClick));
    }

    if (resolvedAddChatTabBtn) {
        const onAddClick = (e) => {
            e?.stopPropagation?.();
            hideTabContextMenu();
            if (resolvedAddMenuPopover) {
                const isOpen = resolvedAddMenuPopover.style.display !== 'none';
                resolvedAddMenuPopover.style.display = isOpen ? 'none' : 'flex';
            } else if (typeof onOpenSideChat === 'function') {
                onOpenSideChat({ forceNew: true });
            }
        };
        resolvedAddChatTabBtn.addEventListener('click', onAddClick);
        cleanupListeners.push(() => resolvedAddChatTabBtn.removeEventListener('click', onAddClick));
    }

    if (resolvedAddMenuPopover) {
        const onAddMenuClick = async (e) => {
            const actionBtn = e.target.closest('[data-action]');
            if (!actionBtn) return;
            const action = actionBtn.getAttribute('data-action');
            hideAddMenu();

            if (action === 'new-chat') {
                if (typeof onOpenSideChat === 'function') {
                    await onOpenSideChat({ forceNew: true });
                }
            } else if (action === 'notifications') {
                controller.showNotifications();
            } else if (action === 'launcher') {
                controller.showLauncher();
            } else if (action === 'review' || action === 'terminal') {
                const label = action === 'review' ? '代码审阅' : '终端';
                const toast = (typeof globalThis !== 'undefined' && globalThis.uiHelperFunctions?.showToastNotification)
                    || doc.defaultView?.uiHelperFunctions?.showToastNotification;
                toast?.(`${label}功能正在深度建设中，敬请期待！`, 'info');
            }
        };
        resolvedAddMenuPopover.addEventListener('click', onAddMenuClick);
        cleanupListeners.push(() => resolvedAddMenuPopover.removeEventListener('click', onAddMenuClick));
    }

    const launcherView = contentContainer?.querySelector?.('#sidePaneViewLauncher')
        || contentContainer?.querySelector?.('[data-tab-id="launcher"]');
    if (launcherView) {
        const onLauncherClick = async (e) => {
            const btn = e.target.closest('[data-side-pane-open-tab-item]');
            if (!btn) return;
            const item = btn.getAttribute('data-side-pane-open-tab-item');
            if (item === 'selection-side-conversation') {
                if (typeof onOpenSideChat === 'function') {
                    await onOpenSideChat({ forceNew: true });
                }
            } else if (item === 'notifications') {
                controller.showNotifications();
            } else if (item === 'review' || item === 'terminal') {
                const label = item === 'review' ? '代码审阅' : '工作区终端';
                const toast = (typeof globalThis !== 'undefined' && globalThis.uiHelperFunctions?.showToastNotification)
                    || doc.defaultView?.uiHelperFunctions?.showToastNotification;
                toast?.(`${label}功能即将上线，敬请期待！`, 'info');
            }
        };
        launcherView.addEventListener('click', onLauncherClick);
        cleanupListeners.push(() => launcherView.removeEventListener('click', onLauncherClick));
    }

    // Initial render
    renderTabList();
    renderTabOverviewPopover();
    syncViewPanels();
    syncDomVisibility();

    if (scope && typeof scope.own === 'function') {
        scope.own(controller, 'side-pane-controller');
    }

    return controller;
}

const api = Object.freeze({ createSidePaneController });

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneController = api;
}

export default api;
