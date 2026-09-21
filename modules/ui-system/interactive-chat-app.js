import { register } from './next-ui-apps.js';
import { mountSideChatSurface } from '../renderer/sideChatSurfaceOwner.js';

function mountInteractiveChat(container, context = {}) {
    const chatSnapshot = context.chat?.getSnapshot?.() || null;
    const scope = context.scope?.child?.('next:interactive-chat') || null;

    if (!chatSnapshot?.selectedItem?.id || !chatSnapshot?.topicId) {
        container.innerHTML = '<section class="vcp-standalone-chat" aria-label="独立聊天"><p role="status">聊天能力尚未就绪</p></section>';
        return async () => {
            scope?.dispose?.('interactive-chat-unavailable');
            container.replaceChildren();
        };
    }

    const descriptor = {
        schemaVersion: 1,
        id: `standalone-${Date.now()}`,
        parent: {
            itemType: 'agent',
            itemId: chatSnapshot.selectedItem.id,
            topicId: chatSnapshot.topicId,
            name: chatSnapshot.selectedItem.name || null,
            avatar: chatSnapshot.selectedItem.avatarUrl || null
        },
        child: {
            itemType: 'agent',
            itemId: chatSnapshot.selectedItem.id,
            topicId: chatSnapshot.topicId
        },
        title: '独立聊天',
        contextMode: 'references-only'
    };

    let tabHandle = null;
    const mountPromise = mountSideChatSurface(container, {
        descriptor,
        chatCapabilities: context.chat,
        scope
    }).then(h => { tabHandle = h; return h; });

    return async () => {
        const handle = tabHandle || await mountPromise;
        await handle?.dispose?.();
        scope?.dispose?.('interactive-chat-unmounted');
        container.replaceChildren();
    };
}

register({ id: 'standalone-chat-compose', title: '独立聊天', icon: 'message-circle', kind: 'internal', discoverable: false, mount: mountInteractiveChat });

