/* Pure state transitions and validation for the Workspace Side Pane and Side Chat. */
'use strict';

export const SCHEMA_VERSION = 1;
export const DEFAULT_WIDTH = 360;
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 800;
export const NOTIFICATIONS_TAB_ID = 'notifications';

export const NOTIFICATIONS_TAB = Object.freeze({
    id: NOTIFICATIONS_TAB_ID,
    kind: 'notifications',
    title: '通知'
});

export function matchesConversation(refA, refB) {
    if (!refA || !refB) return false;
    return refA.itemType === refB.itemType
        && refA.itemId === refB.itemId
        && refA.topicId === refB.topicId;
}

export function freezeDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError('SideChatDescriptor must be an object');
    }
    if (!descriptor.id || typeof descriptor.id !== 'string') {
        throw new TypeError('SideChatDescriptor requires a string id');
    }
    if (!descriptor.parent || typeof descriptor.parent !== 'object') {
        throw new TypeError('SideChatDescriptor requires a parent conversation reference');
    }
    if (!descriptor.child || typeof descriptor.child !== 'object') {
        throw new TypeError('SideChatDescriptor requires a child conversation reference');
    }
    if (descriptor.parent.topicId === descriptor.child.topicId) {
        throw new Error('Child topicId must differ from parent topicId');
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        id: descriptor.id,
        parent: Object.freeze({
            itemType: descriptor.parent.itemType || 'agent',
            itemId: String(descriptor.parent.itemId || ''),
            topicId: String(descriptor.parent.topicId || '')
        }),
        child: Object.freeze({
            itemType: descriptor.child.itemType || 'agent',
            itemId: String(descriptor.child.itemId || ''),
            topicId: String(descriptor.child.topicId || '')
        }),
        title: String(descriptor.title || '侧聊'),
        createdAt: Number.isFinite(descriptor.createdAt) ? descriptor.createdAt : Date.now(),
        contextMode: descriptor.contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
        snapshotId: descriptor.snapshotId ? String(descriptor.snapshotId) : undefined
    });
}

export function createInitialSidePaneState(options = {}) {
    const preferredWidth = Number.isFinite(options.preferredWidth)
        ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(options.preferredWidth)))
        : DEFAULT_WIDTH;

    const initialTabs = [NOTIFICATIONS_TAB];
    if (Array.isArray(options.tabs)) {
        options.tabs.forEach(tab => {
            if (tab && tab.id !== NOTIFICATIONS_TAB_ID && tab.kind === 'chat' && tab.descriptor) {
                initialTabs.push(Object.freeze({
                    id: tab.id,
                    kind: 'chat',
                    title: tab.title || tab.descriptor.title || '侧聊',
                    descriptor: freezeDescriptor(tab.descriptor)
                }));
            }
        });
    }

    const activeTabId = options.activeTabId && initialTabs.some(t => t.id === options.activeTabId)
        ? options.activeTabId
        : NOTIFICATIONS_TAB_ID;

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        visible: Boolean(options.visible),
        preferredWidth,
        activeTabId,
        tabs: Object.freeze(initialTabs),
        parent: options.parent ? Object.freeze({ ...options.parent }) : null
    });
}

export function setVisible(state, visible) {
    const nextVisible = Boolean(visible);
    if (state.visible === nextVisible) return state;
    return Object.freeze({
        ...state,
        visible: nextVisible
    });
}

export function setPreferredWidth(state, width, bounds = {}) {
    const min = Number.isFinite(bounds.min) ? bounds.min : MIN_WIDTH;
    const max = Number.isFinite(bounds.max) ? bounds.max : MAX_WIDTH;
    const normalized = Math.max(min, Math.min(max, Math.round(width)));
    if (state.preferredWidth === normalized) return state;
    return Object.freeze({
        ...state,
        preferredWidth: normalized
    });
}

export function setParent(state, parentRef) {
    const nextParent = parentRef
        ? Object.freeze({
            itemType: parentRef.itemType || 'agent',
            itemId: String(parentRef.itemId || ''),
            topicId: String(parentRef.topicId || '')
        })
        : null;

    if (matchesConversation(state.parent, nextParent)) return state;

    const visibleTabs = getVisibleTabs({ ...state, parent: nextParent }, nextParent);
    let nextActiveTabId = state.activeTabId;
    if (!visibleTabs.some(t => t.id === nextActiveTabId)) {
        nextActiveTabId = visibleTabs[0]?.id || NOTIFICATIONS_TAB_ID;
    }

    return Object.freeze({
        ...state,
        parent: nextParent,
        activeTabId: nextActiveTabId
    });
}

export const LAUNCHER_TAB_ID = 'launcher';

export function activateTab(state, tabId) {
    if (!tabId || state.activeTabId === tabId) return state;
    if (tabId !== LAUNCHER_TAB_ID && !state.tabs.some(tab => tab.id === tabId)) return state;
    return Object.freeze({
        ...state,
        activeTabId: tabId
    });
}

export function showNotifications(state) {
    if (state.activeTabId === NOTIFICATIONS_TAB_ID && state.visible) return state;
    return Object.freeze({
        ...state,
        visible: true,
        activeTabId: NOTIFICATIONS_TAB_ID
    });
}

export function showLauncher(state) {
    if (state.activeTabId === LAUNCHER_TAB_ID && state.visible) return state;
    return Object.freeze({
        ...state,
        visible: true,
        activeTabId: LAUNCHER_TAB_ID
    });
}

export function openChatTab(state, rawDescriptor) {
    const descriptor = freezeDescriptor(rawDescriptor);
    const existingIndex = state.tabs.findIndex(tab => tab.id === descriptor.id || (
        tab.kind === 'chat' && tab.descriptor && tab.descriptor.child.topicId === descriptor.child.topicId
    ));

    let nextTabs = state.tabs;
    let targetTabId = descriptor.id;

    if (existingIndex >= 0) {
        targetTabId = state.tabs[existingIndex].id;
    } else {
        const newTab = Object.freeze({
            id: descriptor.id,
            kind: 'chat',
            title: descriptor.title,
            descriptor
        });
        nextTabs = Object.freeze([...state.tabs, newTab]);
    }

    return Object.freeze({
        ...state,
        visible: true,
        activeTabId: targetTabId,
        tabs: nextTabs
    });
}

export function closeTab(state, tabId) {
    if (!tabId || tabId === NOTIFICATIONS_TAB_ID) return state;
    const tabIndex = state.tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex === -1) return state;

    const nextTabs = state.tabs.filter(tab => tab.id !== tabId);
    let nextActiveTabId = state.activeTabId;

    if (state.activeTabId === tabId) {
        // Fallback: previous tab if exists, else next tab, else notifications tab
        const fallbackTab = nextTabs[Math.max(0, tabIndex - 1)] || NOTIFICATIONS_TAB;
        nextActiveTabId = fallbackTab.id;
    }

    return Object.freeze({
        ...state,
        activeTabId: nextActiveTabId,
        tabs: Object.freeze(nextTabs)
    });
}

export function closeOtherTabs(state, tabId) {
    if (!tabId) return state;
    const targetTab = state.tabs.find(t => t.id === tabId);
    if (!targetTab) return state;

    const nextTabs = state.tabs.filter(t => t.id === tabId || t.id === NOTIFICATIONS_TAB_ID);
    return Object.freeze({
        ...state,
        activeTabId: tabId,
        tabs: Object.freeze(nextTabs)
    });
}

export function closeAllTabs(state) {
    const nextTabs = state.tabs.filter(t => t.id === NOTIFICATIONS_TAB_ID);
    return Object.freeze({
        ...state,
        activeTabId: LAUNCHER_TAB_ID,
        tabs: Object.freeze(nextTabs)
    });
}

export function getVisibleTabs(state, parentRef = null) {
    if (!parentRef) return state.tabs;
    return state.tabs.filter(tab => {
        if (tab.id === NOTIFICATIONS_TAB_ID) return true;
        if (tab.kind === 'chat' && tab.descriptor) {
            return matchesConversation(tab.descriptor.parent, parentRef);
        }
        return true;
    });
}

const api = Object.freeze({
    SCHEMA_VERSION,
    DEFAULT_WIDTH,
    MIN_WIDTH,
    MAX_WIDTH,
    NOTIFICATIONS_TAB_ID,
    NOTIFICATIONS_TAB,
    LAUNCHER_TAB_ID,
    matchesConversation,
    freezeDescriptor,
    createInitialSidePaneState,
    setVisible,
    setPreferredWidth,
    setParent,
    activateTab,
    showNotifications,
    showLauncher,
    openChatTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    getVisibleTabs
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneState = api;
}

export default api;
