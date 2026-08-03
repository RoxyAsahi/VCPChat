function createAgentTopicContextMenuView({ document, window, node, visualActionButton, run, actions }) {
    let current = null;
    let instance = 0;

    function close({ returnFocus = false } = {}) {
        if (!current) return;
        const closing = current;
        current = null;
        closing.menu.remove();
        closing.positionRule?.remove();
        document.removeEventListener('pointerdown', closing.onPointerDown, true);
        document.removeEventListener('keydown', closing.onKeyDown, true);
        if (returnFocus && closing.trigger?.isConnected) closing.trigger.focus();
    }

    async function copyTopicId(topicId) {
        try {
            if (!window.navigator?.clipboard?.writeText) throw new Error('clipboard API unavailable');
            await window.navigator.clipboard.writeText(topicId);
            actions.notify('Topic ID 已复制。', 'success');
        } catch {
            const temporary = document.createElement('textarea');
            temporary.value = topicId;
            temporary.className = 'agent-chat-clipboard-proxy';
            temporary.setAttribute('readonly', '');
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand?.('copy');
            temporary.remove();
            if (copied) actions.notify('Topic ID 已复制。', 'success');
            else actions.notify(`无法访问系统剪贴板；Topic ID：${topicId}`, 'warning');
        }
    }

    function addItem(menu, iconName, label, action, { danger = false } = {}) {
        const item = node('div', `context-menu-item agent-chat-topic-context-menu-item${danger ? ' danger-item' : ''}`);
        item.setAttribute('role', 'menuitem');
        item.tabIndex = 0;
        const iconElement = node('i', `fas fa-${iconName}`);
        iconElement.setAttribute('aria-hidden', 'true');
        item.append(iconElement, document.createTextNode(label));
        const invoke = (event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
            run(action);
        };
        item.addEventListener('click', invoke);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') invoke(event);
        });
        menu.append(item);
    }

    function position(menu, point) {
        const gap = 8;
        const width = menu.offsetWidth || 188;
        const height = menu.offsetHeight || 240;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const left = Math.max(gap, Math.min(point.x, viewportWidth - width - gap));
        const top = Math.max(gap, Math.min(point.y, viewportHeight - height - gap));
        const id = String(++instance);
        menu.dataset.agentMenuInstance = id;
        const rule = document.createElement('style');
        rule.textContent = `.agent-chat-topic-context-menu[data-agent-menu-instance="${id}"] { left: ${left}px; top: ${top}px; visibility: visible; }`;
        document.head.append(rule);
        return rule;
    }

    function show(topic, trigger, point, { live = false } = {}) {
        if (!topic?.id || !actions.canOpen()) return;
        close();
        const menu = node('div', 'context-menu agent-chat-topic-context-menu');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', `管理 Topic：${topic.title || topic.id}`);
        menu.hidden = true;
        const archived = Boolean(topic.archivedAt);
        if (live) addItem(menu, 'folder-open', '打开当前会话', () => actions.openLive(topic));
        else {
            addItem(menu, 'folder-open', archived ? '查看归档会话' : '打开会话', () => actions.open(topic));
            if (!archived) addItem(menu, 'edit', '重命名', () => actions.rename(topic));
        }
        addItem(menu, 'copy', '复制 Topic ID', () => copyTopicId(topic.id));
        if (!live) addItem(menu, 'file-export', '导出 Markdown', () => actions.exportMarkdown(topic));
        if (!live && !archived) addItem(menu, 'archive', '归档会话', () => actions.archive(topic));
        else if (!live && archived) {
            addItem(menu, 'undo', '恢复会话', () => actions.restore(topic));
            addItem(menu, 'trash', '永久删除', () => actions.remove(topic), { danger: true });
        }
        const onPointerDown = (event) => {
            if (!menu.contains(event.target) && event.target !== trigger) close();
        };
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            close({ returnFocus: true });
        };
        document.body.append(menu);
        const positionRule = position(menu, point);
        menu.hidden = false;
        current = { menu, trigger, onPointerDown, onKeyDown, positionRule };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        queueMicrotask(() => {
            if (current?.menu === menu && menu.isConnected) menu.querySelector('[role="menuitem"]')?.focus();
        });
    }

    function appendActions(row, topic, { live = false } = {}) {
        const button = visualActionButton('more', `管理 Topic：${topic.title || topic.id}`, 'agent-chat-session-menu');
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = button.getBoundingClientRect();
            show(topic, button, { x: rect.right, y: rect.bottom }, { live });
        });
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            show(topic, button, { x: event.clientX, y: event.clientY }, { live });
        });
        row.append(button);
    }

    return Object.freeze({ show, close, appendActions, dispose: close });
}

export { createAgentTopicContextMenuView };
