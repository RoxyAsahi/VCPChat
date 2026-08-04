import { button, icon, iconButton, node } from './agent-workbench-dom.js';

function createAgentWorkbenchAccountView({ window, document, actions = {}, host = null }) {
    const dock = node('div', 'next-ui-account-dock agent-chat-account-dock', undefined, document);
    const menu = node('div', 'next-ui-account-menu agent-chat-account-menu', undefined, document);
    menu.hidden = true;
    const closeMenu = () => { menu.hidden = true; };
    const themeStore = button('主题选择', 'next-ui-account-menu-item', document);
    themeStore.prepend(...icon('palette', undefined, document));
    themeStore.addEventListener('click', () => { closeMenu(); actions.openThemes?.(); });
    const themeToggle = button('', 'next-ui-account-menu-item', document);
    themeToggle.addEventListener('click', () => { closeMenu(); actions.toggleTheme?.(); });
    const presentationLabels = { bubble: '气泡', panel: '面板', immersive: '沉浸' };
    const getPresentationMode = () => {
        if (document.body.classList.contains('chat-presentation-panel')) return 'panel';
        if (document.body.classList.contains('chat-presentation-immersive')) return 'immersive';
        return host?.presentation?.read?.() || 'bubble';
    };
    const presentationItem = node('button', 'agent-chat-button next-ui-account-menu-item', undefined, document);
    presentationItem.type = 'button';
    presentationItem.prepend(...icon('view_agenda', undefined, document));
    presentationItem.append(
        node('span', 'next-ui-account-menu-label', '聊天显示模式', document),
        node('span', 'next-ui-account-menu-value agent-chat-account-presentation-value', presentationLabels[getPresentationMode()] || '气泡', document),
        ...icon('chevron_right', undefined, document),
    );
    presentationItem.setAttribute('aria-expanded', 'false');
    const presentationOptions = node('div', 'next-ui-account-submenu agent-chat-account-presentation-options', undefined, document);
    presentationOptions.setAttribute('role', 'group');
    presentationOptions.setAttribute('aria-label', '选择聊天显示模式');
    presentationOptions.hidden = true;
    for (const [mode, iconName, label] of [
        ['bubble', 'chat_bubble', '气泡模式'],
        ['panel', 'view_day', '面板模式'],
        ['immersive', 'fullscreen', '沉浸模式'],
    ]) {
        const option = node('button', 'next-ui-account-submenu-item', undefined, document);
        option.type = 'button';
        option.dataset.presentationMode = mode;
        option.append(
            ...icon(iconName, undefined, document),
            node('span', '', label, document),
            node('span', 'vcp-ui-icon next-ui-account-option-check', 'check', document),
        );
        option.addEventListener('click', async () => {
            await actions.setPresentationMode?.(mode);
            closeMenu();
        });
        presentationOptions.append(option);
    }
    presentationItem.addEventListener('click', () => {
        const expanded = presentationOptions.hidden;
        presentationOptions.hidden = !expanded;
        presentationItem.setAttribute('aria-expanded', String(!expanded));
    });
    menu.append(themeStore, themeToggle, presentationItem, presentationOptions);

    const trigger = node('button', 'next-ui-account-trigger', undefined, document);
    trigger.type = 'button';
    trigger.title = '全局设置';
    const avatar = document.createElement('img');
    avatar.className = 'agent-chat-account-avatar';
    avatar.alt = '';
    const name = node('span', 'agent-chat-account-name', '', document);
    trigger.append(avatar, name, ...icon('expand_less', undefined, document));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
        trigger.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) presentationOptions.hidden = true;
    });
    const settings = iconButton('settings', '全局设置', 'next-ui-account-settings', document);
    settings.addEventListener('click', () => { closeMenu(); actions.openGlobalSettings?.(); });
    dock.append(menu, trigger, settings);

    function update() {
        const dark = document.body.classList.contains('dark-theme');
        themeStore.replaceChildren(...icon('palette', undefined, document), document.createTextNode('主题选择'));
        themeToggle.replaceChildren(
            ...icon(dark ? 'light_mode' : 'dark_mode', undefined, document),
            document.createTextNode(dark ? '切换为浅色模式' : '切换为深色模式'),
        );
        const mode = getPresentationMode();
        menu.querySelector('.agent-chat-account-presentation-value').textContent = presentationLabels[mode] || '气泡';
        presentationOptions.querySelectorAll('[data-presentation-mode]').forEach((option) => {
            const active = option.dataset.presentationMode === mode;
            option.classList.toggle('active', active);
            option.setAttribute('aria-pressed', String(active));
        });
        avatar.src = host?.account?.avatarUrl || 'assets/default_user_avatar.png';
        name.textContent = host?.account?.userName?.trim() || '用户';
    }
    update();
    let observer = null;
    if (typeof window.MutationObserver !== 'undefined') {
        observer = new window.MutationObserver(update);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    return {
        element: dock,
        update,
        dispose() {
            observer?.disconnect();
            observer = null;
            dock.remove();
        },
    };
}

export { createAgentWorkbenchAccountView };
