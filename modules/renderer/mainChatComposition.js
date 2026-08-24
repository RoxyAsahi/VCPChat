import { createChatOperations } from '../chat/chatOperation.js';
import { createChatSurfaceSlots } from '../chat/chatSurfaceSlots.js';
import { createMainChatSurfaceAdapter } from './mainChatSurfaceAdapter.js';

/**
 * Owns the main chat Surface composition. This module deliberately receives
 * already-created providers; it does not discover renderer globals or bind
 * application services itself.
 */
export function createMainChatComposition({
    root,
    messageInput,
    messageRenderer,
    streamProjection,
    chatRepository,
    historyPersistence,
    presentationState,
    renderDependencies,
    chatManager,
    flowlockManager,
    currentSelection,
    currentTopicId,
    chatWindow,
    dispatchTerminal,
    notifySendStateChanged,
    interrupt,
    showForwardModal,
    provideCapabilities,
    capabilitySnapshot,
    settings,
    createInternalRenderer,
    disposeCapabilities,
    composerSlotRoot = null,
    slotOwner = null,
    composerControls = null,
}) {
    const slots = createChatSurfaceSlots();
    const registerRelocatedControl = (id, element, priority) => {
        if (!element) return;
        slots.register('chat.composer.leading', id, (host) => {
            const parent = element.parentNode;
            const next = element.nextSibling;
            host.style.display = 'contents';
            host.dataset.chatSlotContribution = id;
            host.appendChild(element);
            return () => {
                if (!parent) return;
                if (next && next.parentNode === parent) parent.insertBefore(element, next);
                else parent.appendChild(element);
            };
        }, { owner: slotOwner, priority, scope: 'session-maybe' });
    };
    registerRelocatedControl('core-attachment', composerControls?.attachFileBtn, 0);
    registerRelocatedControl('core-emoticon', composerControls?.emoticonTriggerBtn, 10);
    const adapter = createMainChatSurfaceAdapter({
        root,
        renderer: messageRenderer,
        repository: chatRepository,
        focusTarget: messageInput,
        operations: createChatOperations({
            send: request => chatManager?.sendMessage?.(request),
            cancel: () => interrupt(),
        }),
        presentationState,
        renderDependencies,
        streamServices: {
            streamProjection,
            historyPersistence,
            messageRenderer,
            chatManager,
            flowlockManager,
            getSelection: currentSelection,
            getTopicId: currentTopicId,
            dispatchTerminal,
            notifySendStateChanged,
        },
        slots,
        composerSlotRoot,
        slotOwner,
        disposeRenderer: async () => {
            await messageRenderer.disposeRootResources(root);
            messageRenderer.disposeRendererResources();
            await streamProjection?.dispose?.();
        },
        ownerWindow: chatWindow,
        onDispose: async () => {
            await disposeCapabilities?.();
        },
    });

    const release = provideCapabilities?.({
        repository: chatRepository,
        getSnapshot: capabilitySnapshot,
        createRenderer: createInternalRenderer,
        manager: chatManager,
        presentation: presentationState,
        settings,
        slots: Object.freeze({
            register: slots.register,
            describe: slots.describe,
            diagnostics: () => slots.diagnostics(),
        }),
    }) || null;

    messageRenderer.setContextMenuDependencies({
        showForwardModal,
        acceptStreamEvent: event => adapter.acceptStreamEvent(event),
        cancelStream: (messageId, reason) => adapter.cancelStream(messageId, reason),
    });

    return Object.freeze({
        adapter,
        surface: adapter.surface,
        domRenderer: adapter.domRenderer,
        slots,
        releaseCapabilities: release,
    });
}
