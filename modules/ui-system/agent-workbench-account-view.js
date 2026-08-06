import { icon, iconButton, node } from './agent-workbench-dom.js';

function createAgentWorkbenchAccountView({ window, document, actions = {}, host = null }) {
    const dock = node('div', 'next-ui-account-dock agent-chat-account-dock', undefined, document);
    const menu = node('div', 'next-ui-account-menu agent-chat-account-menu', undefined, document);
    menu.hidden = true;
    const closeMenu = () => {
        menu.hidden = true;
        trigger?.setAttribute('aria-expanded', 'false');
    };
    const appearanceStudio = node('button', 'agent-chat-button next-ui-account-menu-item', undefined, document);
    appearanceStudio.type = 'button';
    appearanceStudio.append(
        ...icon('tune', undefined, document),
        node('span', 'next-ui-account-menu-label', '外观与布局', document),
        ...icon('chevron_right', undefined, document),
    );
    appearanceStudio.addEventListener('click', () => {
        closeMenu();
        actions.openAppearanceStudio?.(appearanceStudio);
    });
    const themeToggle = node('button', 'agent-chat-button next-ui-account-menu-item', undefined, document);
    themeToggle.type = 'button';
    const themeLabel = node('span', 'next-ui-account-menu-label', '切换为深色模式', document);
    themeToggle.append(...icon('dark_mode', undefined, document), themeLabel);
    const syncTheme = () => {
        const isDark = document.body.classList.contains('dark-theme');
        const nextLabel = isDark ? '切换为浅色模式' : '切换为深色模式';
        const themeIcon = themeToggle.querySelector('.vcp-ui-icon, [data-vcp-icon]');
        if (themeIcon) window.VCPIcons?.set(themeIcon, isDark ? 'light_mode' : 'dark_mode');
        themeLabel.textContent = nextLabel;
        themeToggle.setAttribute('aria-label', nextLabel);
        themeToggle.setAttribute('aria-pressed', String(isDark));
    };
    themeToggle.addEventListener('click', () => {
        closeMenu();
        actions.toggleTheme?.();
    });
    menu.append(appearanceStudio, themeToggle);

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
    });
    const settings = iconButton('settings', '全局设置', 'next-ui-account-settings', document);
    settings.addEventListener('click', () => { closeMenu(); actions.openGlobalSettings?.(); });
    dock.append(menu, trigger, settings);
    const ThemeObserver = window.MutationObserver || globalThis.MutationObserver;
    const themeObserver = ThemeObserver ? new ThemeObserver(syncTheme) : null;
    themeObserver?.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    function update() {
        avatar.src = host?.account?.avatarUrl || 'assets/default_user_avatar.png';
        name.textContent = host?.account?.userName?.trim() || '用户';
        syncTheme();
    }
    update();
    return {
        element: dock,
        update,
        dispose() {
            themeObserver?.disconnect();
            dock.remove();
        },
    };
}

export { createAgentWorkbenchAccountView };
