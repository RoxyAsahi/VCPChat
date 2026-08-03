import { button, node } from './agent-workbench-dom.js';

export function createAgentSessionDockView({ refs, document, actions }) {
    const { activityTabs, activityAdd, activityContent, activityTabRow } = refs;
    const tabButtons = new Map();
    const panels = new Map();
    let model = null;

    function buildMenu(commands) {
        const menu = node('div', 'agent-chat-dock-menu');
        menu.setAttribute('role', 'menu');
        for (const command of commands) {
            const item = button('', 'agent-chat-dock-menu-item');
            item.setAttribute('role', 'menuitem');
            item.append(
                node('span', 'vcp-ui-icon', command.icon),
                node('span', '', command.label),
            );
            item.addEventListener('click', command.run);
            menu.append(item);
        }
        return menu;
    }

    function ensureTab(definition) {
        let tab = tabButtons.get(definition.id);
        if (tab) return tab;
        tab = node('button', 'agent-chat-activity-tab');
        tab.type = 'button';
        tab.dataset.tab = definition.id;
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', (event) => {
            if (!event.target.closest('.agent-chat-dock-tab-close')) actions.activate(definition.id, definition.kind);
        });
        tab.addEventListener('auxclick', (event) => {
            if (event.button !== 1 || !definition.closeable) return;
            event.preventDefault();
            actions.close(definition.id);
        });
        tab.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const index = model.tabs.findIndex((item) => item.id === definition.id);
            const next = model.tabs[index + (event.key === 'ArrowRight' ? 1 : -1)];
            if (!next) return;
            event.preventDefault();
            actions.activate(next.id, next.kind);
            queueMicrotask(() => tabButtons.get(next.id)?.focus());
        });
        tabButtons.set(definition.id, tab);
        return tab;
    }

    function updateTab(tab, definition) {
        const count = Number(definition.badge || 0);
        tab.dataset.kind = definition.kind;
        tab.classList.toggle('is-launcher', definition.kind === 'files');
        tab.replaceChildren(node('span', 'vcp-ui-icon agent-chat-dock-tab-icon', definition.icon));
        tab.append(node('span', 'agent-chat-dock-tab-label', definition.title));
        tab.title = definition.kind === 'file' ? definition.relativePath : definition.title;
        if (count) tab.append(node('span', 'agent-chat-dock-tab-badge', String(Math.min(99, count))));
        if (definition.closeable) {
            const close = node('span', 'agent-chat-dock-tab-close');
            close.setAttribute('role', 'button');
            close.setAttribute('aria-label', `关闭${definition.title}标签`);
            close.append(node('span', 'vcp-ui-icon agent-chat-dock-tab-close-icon', 'close'));
            close.addEventListener('click', (event) => {
                event.stopPropagation();
                actions.close(definition.id);
            });
            tab.append(close);
        }
        tab.classList.toggle('is-active', model.activeId === definition.id);
        tab.setAttribute('aria-selected', String(model.activeId === definition.id));
    }

    function ensurePanel(id) {
        let panel = panels.get(id);
        if (panel) return panel;
        panel = node('div', 'agent-chat-activity-tabpanel');
        panel.dataset.activityPanel = id;
        panel.setAttribute('role', 'tabpanel');
        panels.set(id, panel);
        activityContent.append(panel);
        return panel;
    }

    function render() {
        const visibleIds = new Set(model.tabs.map((tab) => tab.id));
        for (const [id, tab] of tabButtons) {
            if (visibleIds.has(id)) continue;
            tab.remove();
            tabButtons.delete(id);
        }
        for (const definition of model.tabs) {
            const tab = ensureTab(definition);
            updateTab(tab, definition);
            activityTabs.append(tab);
        }

        activityAdd.setAttribute('aria-expanded', String(model.menuOpen));
        activityTabRow.querySelector('.agent-chat-dock-menu')?.remove();
        if (model.menuOpen) activityTabRow.append(buildMenu(model.commands));

        for (const [id, panel] of panels) {
            if (visibleIds.has(id)) continue;
            panel.remove();
            panels.delete(id);
        }
        for (const definition of model.tabs) {
            const panel = ensurePanel(definition.id);
            panel.hidden = definition.id !== model.activeId;
        }
    }

    const onAdd = (event) => {
        event.stopPropagation();
        actions.toggleMenu();
    };
    const onOutsideClick = (event) => {
        if (model?.menuOpen && !activityTabRow.contains(event.target)) actions.closeMenu();
    };
    activityAdd.addEventListener('click', onAdd);
    document.addEventListener('click', onOutsideClick);

    return {
        element: refs.activityPanel,
        update(nextModel) {
            model = nextModel;
            render();
            return panels.get(model.activeId) || null;
        },
        activePanel() {
            return model ? panels.get(model.activeId) || null : null;
        },
        dispose() {
            activityAdd.removeEventListener('click', onAdd);
            document.removeEventListener('click', onOutsideClick);
            tabButtons.clear();
            panels.clear();
            activityTabs.replaceChildren();
            activityContent.replaceChildren();
            activityTabRow.querySelector('.agent-chat-dock-menu')?.remove();
        },
    };
}
