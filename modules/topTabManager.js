(() => {
    const APP_TONES = ['purple', 'green', 'pink', 'cyan', 'amber', 'charcoal', 'red', 'orange'];
    let initialized = false;
    let launchpadTab = null;

    function setView(view) {
        const isLaunchpad = view === 'launchpad';
        document.body.classList.toggle('next-ui-launchpad-open', isLaunchpad);

        const homeTab = document.getElementById('nextUiHomeTab');
        const launchpad = document.getElementById('nextUiLaunchpad');
        const addButton = document.getElementById('nextUiAddTabBtn');

        homeTab?.classList.toggle('active', !isLaunchpad);
        homeTab?.setAttribute('aria-selected', String(!isLaunchpad));
        launchpadTab?.classList.toggle('active', isLaunchpad);
        launchpadTab?.setAttribute('aria-selected', String(isLaunchpad));
        addButton?.classList.toggle('active', isLaunchpad && !launchpadTab);
        launchpad?.setAttribute('aria-hidden', String(!isLaunchpad));
    }

    function closeLaunchpadTab() {
        launchpadTab?.remove();
        launchpadTab = null;
        setView('home');
    }

    function ensureLaunchpadTab() {
        if (launchpadTab?.isConnected) return launchpadTab;

        const tabs = document.getElementById('nextUiDynamicTabs');
        if (!tabs) return null;

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'next-ui-tab';
        tab.setAttribute('aria-selected', 'false');
        tab.innerHTML = `
            <span class="next-ui-tab-label">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="4" y="4" width="6" height="6" rx="1"></rect>
                    <rect x="14" y="4" width="6" height="6" rx="1"></rect>
                    <rect x="4" y="14" width="6" height="6" rx="1"></rect>
                    <rect x="14" y="14" width="6" height="6" rx="1"></rect>
                </svg>
                <span>应用</span>
            </span>
            <span class="next-ui-tab-close" role="button" aria-label="关闭应用标签" title="关闭标签">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>
            </span>
        `;

        tab.addEventListener('click', (event) => {
            if (event.target.closest('.next-ui-tab-close')) {
                event.stopPropagation();
                closeLaunchpadTab();
                return;
            }
            setView('launchpad');
        });

        tabs.appendChild(tab);
        launchpadTab = tab;
        return tab;
    }

    function openLaunchpad() {
        ensureLaunchpadTab();
        setView('launchpad');
    }

    function renderApps() {
        const grid = document.getElementById('nextUiAppGrid');
        const trayManager = window.trayManager;
        if (!grid || !trayManager?.getApps) return;

        grid.innerHTML = '';
        const apps = trayManager.getApps().filter(app => app.id !== 'vchat-app-main');

        apps.forEach((app, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'next-ui-app-item';
            button.title = app.name;
            button.innerHTML = `
                <span class="next-ui-app-icon" data-tone="${APP_TONES[index % APP_TONES.length]}">
                    ${trayManager.getIcon(app.icon)}
                </span>
                <span>${app.name}</span>
            `;
            button.addEventListener('click', () => trayManager.launchApp(app));
            grid.appendChild(button);
        });
    }

    function proxyClick(targetId) {
        document.getElementById(targetId)?.click();
    }

    function init() {
        if (initialized) return;
        initialized = true;

        renderApps();

        document.getElementById('nextUiHomeTab')?.addEventListener('click', () => setView('home'));
        document.getElementById('nextUiAddTabBtn')?.addEventListener('click', openLaunchpad);
        document.getElementById('nextUiThemeStoreBtn')?.addEventListener('click', () => {
            (window.chatAPI || window.electronAPI)?.openThemesWindow?.();
        });
        document.getElementById('nextUiThemeBtn')?.addEventListener('click', () => proxyClick('themeToggleBtn'));
        document.getElementById('nextUiSettingsBtn')?.addEventListener('click', () => {
            window.uiHelperFunctions?.openModal?.('globalSettingsModal');
        });
        document.getElementById('nextUiMinimizeBtn')?.addEventListener('click', () => proxyClick('minimize-btn'));
        document.getElementById('nextUiMaximizeBtn')?.addEventListener('click', () => {
            const restoreButton = document.getElementById('restore-btn');
            const shouldRestore = restoreButton && window.getComputedStyle(restoreButton).display !== 'none';
            proxyClick(shouldRestore ? 'restore-btn' : 'maximize-btn');
        });
        document.getElementById('nextUiCloseBtn')?.addEventListener('click', () => proxyClick('close-btn'));

        window.addEventListener('ui-mode-changed', (event) => {
            if (event.detail?.mode !== 'next') setView('home');
        });
    }

    window.topTabManager = Object.freeze({ init, openLaunchpad, setView });
})();
