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
    const initialWidth = Number(settingsRef?.get?.()?.notificationsSidebarWidth)
        || SidePaneState.DEFAULT_WIDTH;

    let state = SidePaneState.createInitialSidePaneState({
        preferredWidth: initialWidth,
        visible: root.classList.contains('active') || root.getAttribute('aria-hidden') === 'false'
    });

    const mountedTabMap = new Map(); // tabId -> { provider, viewElement, tabElement, handle }
    const cleanupListeners = [];
    let isDisposed = false;

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

        const visibleTabs = SidePaneState.getVisibleTabs(state, state.parent);

        visibleTabs.forEach(tab => {
            const isActive = tab.id === state.activeTabId;
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = `side-pane-tab${isActive ? ' active' : ''}`;
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('data-tab-id', tab.id);

            const iconSpan = doc.createElement('span');
            iconSpan.className = 'tab-icon vcp-ui-icon';
            iconSpan.setAttribute('aria-hidden', 'true');
            iconSpan.textContent = tab.kind === 'notifications' ? 'notifications' : 'chat_bubble';

            const titleSpan = doc.createElement('span');
            titleSpan.className = 'tab-title';
            titleSpan.textContent = tab.title;

            btn.append(iconSpan, titleSpan);

            // Close button for closable tabs (chat tabs)
            if (tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID) {
                const closeBtn = doc.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'side-pane-tab-close';
                closeBtn.title = '关闭此侧聊';
                closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
                closeBtn.innerHTML = '<span class="vcp-ui-icon" style="font-size:12px;">close</span>';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    controller.closeTab(tab.id);
                });
                btn.appendChild(closeBtn);
            }

            btn.addEventListener('click', () => {
                controller.activateTab(tab.id);
            });

            tabListElement.appendChild(btn);
        });
    }

    function syncViewPanels() {
        if (!contentContainer) return;
        const views = contentContainer.querySelectorAll('.side-pane-view');
        views.forEach(view => {
            const viewTabId = view.getAttribute('data-tab-id') || (
                view.id === 'sidePaneViewNotifications' ? SidePaneState.NOTIFICATIONS_TAB_ID : null
            );
            const isActive = viewTabId === state.activeTabId;
            view.classList.toggle('active', isActive);
            view.setAttribute('aria-hidden', String(!isActive));
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
            const isChatActive = isVisible && state.activeTabId !== SidePaneState.NOTIFICATIONS_TAB_ID;
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
            syncDomVisibility();
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

        activateTab(tabId) {
            if (isDisposed || !tabId) return;
            state = SidePaneState.activateTab(state, tabId);
            renderTabList();
            syncViewPanels();
            syncDomVisibility();

            const entry = mountedTabMap.get(tabId);
            entry?.handle?.focus?.();
        },

        async openChat(descriptor) {
            if (isDisposed || !descriptor) return;
            state = SidePaneState.openChatTab(state, descriptor);
            renderTabList();

            // Check if view container already mounted for this tab
            let entry = mountedTabMap.get(descriptor.id);
            if (!entry) {
                let view = contentContainer?.querySelector(`[data-tab-id="${descriptor.id}"]`);
                if (!view && contentContainer) {
                    view = doc.createElement('section');
                    view.className = 'side-pane-view';
                    view.setAttribute('data-tab-id', descriptor.id);
                    view.setAttribute('role', 'tabpanel');
                    contentContainer.appendChild(view);
                }

                if (providers.chat?.mountTab && view) {
                    const handle = await providers.chat.mountTab(descriptor, view);
                    entry = { descriptor, viewElement: view, handle };
                    mountedTabMap.set(descriptor.id, entry);
                } else if (view) {
                    entry = { descriptor, viewElement: view, handle: null };
                    mountedTabMap.set(descriptor.id, entry);
                }
            }

            syncViewPanels();
            syncDomVisibility();
            entry?.handle?.focus?.();
            return entry?.handle || null;
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
            if (entry) {
                const closeResult = await entry.handle?.requestClose?.();
                if (closeResult && closeResult.closed === false) {
                    return; // User or operation prevented close
                }
                if (entry.descriptor && typeof onTabClosed === 'function') {
                    try { await onTabClosed(entry.descriptor); } catch {}
                }
                await entry.handle?.dispose?.();
                entry.viewElement?.remove?.();
                mountedTabMap.delete(tabId);
            }

            state = SidePaneState.closeTab(state, tabId);
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        setParent(parentRef) {
            if (isDisposed) return;
            state = SidePaneState.setParent(state, parentRef);
            renderTabList();
            syncViewPanels();
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

        dispose() {
            if (isDisposed) return;
            isDisposed = true;
            cleanupListeners.forEach(cleanup => cleanup());
            cleanupListeners.length = 0;

            resizerOwner?.dispose?.();

            mountedTabMap.forEach((entry) => {
                entry.handle?.dispose?.();
                entry.viewElement?.remove?.();
            });
            mountedTabMap.clear();
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
                // If a chat tab exists, activate the last chat tab, else trigger onOpenSideChat
                const chatTabs = state.tabs.filter(t => t.kind === 'chat');
                if (chatTabs.length > 0) {
                    controller.activateTab(chatTabs[chatTabs.length - 1].id);
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

    if (addChatTabBtn) {
        const onAddClick = () => {
            if (typeof onOpenSideChat === 'function') {
                onOpenSideChat();
            }
        };
        addChatTabBtn.addEventListener('click', onAddClick);
        cleanupListeners.push(() => addChatTabBtn.removeEventListener('click', onAddClick));
    }

    // Initial render
    renderTabList();
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
