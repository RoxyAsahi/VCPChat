// schema/deskpet-panel — 全局设置「桌宠」分区的面板（自包含 DOM + 行为）。
//
//   上面：当前桌宠的大预览，脚边是和桌面上一样的小胶囊（DeskPetmodules/dock.css 同一份样式），
//         点打字展开成输入条、点说话变成录音按钮；在这里打的字由桌宠发出去，回复显示在桌宠头上。
//   中间：我的桌宠——选助手，再从它的几套形象里挑一张卡片（「无」是收起这个助手的桌宠），
//         卡片上是离屏渲染的快照（主进程 modules/deskpet/petPreviews.js），渲染好一张换一张。
//   下面：免打扰、启动恢复、全局快捷键。
//
// 主进程：modules/deskpet/settingsPage.js、petControls.js（deskpet-settings:*）。不进表单 collect/自动保存。
// 编译期（JSDOM 契约检查）没有 electronAPI，只产出结构。

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');
const CATALOG_DEBOUNCE_MS = 150;

function getApi(doc) {
    const win = doc?.defaultView;
    const api = win?.chatAPI || win?.electronAPI;
    return api && typeof api.getDeskPetCatalog === 'function' ? api : null;
}

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(doc, className, text, attrs = {}) {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    edit: ['M12 20h9', 'M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
    voice: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2'],
    mic: ['M5 11a7 7 0 0 0 14 0', 'M12 18v3', 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z'],
    send: ['M12 19V5', 'm5 12 7-7 7 7'],
    refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    none: ['M5 5l14 14', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'],
};

function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

function formatAccelerator(accelerator) {
    if (!accelerator) return '';
    return accelerator
        .replace('CommandOrControl', IS_MAC ? 'Cmd' : 'Ctrl')
        .replace('Super', IS_MAC ? 'Cmd' : 'Win')
        .split('+').join(' + ');
}

// KeyboardEvent → Electron accelerator 写法；只按了修饰键时返回 null
function acceleratorFromEvent(e) {
    const code = e.code || '';
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^Numpad\d$/.test(code)) key = code.slice(6);
    else if (/^F\d{1,2}$/.test(code)) key = code;
    else {
        key = {
            Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
            PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
            Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
            Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
        }[code] || null;
    }
    if (!key) return null;
    const parts = [];
    if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (!IS_MAC && e.metaKey) parts.push('Super');
    parts.push(key);
    return parts.join('+');
}

// 和桌宠页面同样的小胶囊结构（样式见 DeskPetmodules/dock.css）
function buildDock(doc) {
    const dock = el(doc, 'div', 'pet-dock dps-dock');
    dock.dataset.mode = 'pill';
    const pill = el(doc, 'div', 'dock-layer dock-pill');
    const edit = button(doc, 'dock-btn', undefined, { title: '打字和 TA 说', 'aria-label': '打字' });
    edit.append(icon(doc, 'edit'));
    const voice = button(doc, 'dock-btn', undefined, { title: '说话（本地语音识别）', 'aria-label': '说话' });
    voice.append(icon(doc, 'voice'));
    pill.append(edit, el(doc, 'i', 'dock-sep'), voice);
    const bar = el(doc, 'form', 'dock-layer dock-bar');
    const mic = button(doc, 'dock-btn dock-round', undefined, { title: '改成说话', 'aria-label': '说话' });
    mic.append(icon(doc, 'mic'));
    const input = el(doc, 'textarea', 'dock-input');
    input.rows = 1;
    input.maxLength = 8000;
    input.setAttribute('aria-label', '和桌宠说的话');
    const send = button(doc, 'dock-send is-empty', undefined, { title: '发送（Enter）', 'aria-label': '发送' });
    send.append(icon(doc, 'send'));
    bar.append(mic, input, send);
    const rec = el(doc, 'div', 'dock-layer dock-rec');
    const recEdit = button(doc, 'dock-btn', undefined, { title: '改成打字', 'aria-label': '打字' });
    recEdit.append(icon(doc, 'edit'));
    const stop = button(doc, 'rec-stop', undefined, { title: '说完了（Esc 取消）', 'aria-label': '说完了' });
    stop.append(el(doc, 'span', 'rec-dot'));
    rec.append(recEdit, stop);
    dock.append(pill, bar, rec);
    return { dock, edit, voice, bar, mic, input, send, recEdit, stop };
}

function buildSwitchRow(doc, title, hint) {
    const row = el(doc, 'label', 'dps-row');
    const copy = el(doc, 'span', 'dps-row-copy');
    copy.append(el(doc, 'span', 'dps-row-title', title), el(doc, 'span', 'dps-row-hint', hint));
    const toggle = el(doc, 'span', 'dps-switch');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    toggle.append(input, el(doc, 'span', 'dps-switch-knob'));
    row.append(copy, toggle);
    return { row, input };
}

export function buildDeskPetPanel(doc) {
    const root = el(doc, 'div', 'dps');
    root.id = 'deskPetSettingsPanel';

    // ---- 结构 ----
    const intro = el(doc, 'div', 'dps-intro');
    const lead = el(doc, 'p', 'dps-lead');
    const visibleBtn = button(doc, 'dps-btn', '隐藏桌宠');
    intro.append(lead, visibleBtn);

    const stage = el(doc, 'section', 'dps-stage');
    stage.dataset.state = 'empty';
    const figure = el(doc, 'div', 'dps-stage-figure');
    const floor = el(doc, 'div', 'dps-stage-floor');
    const stageNote = el(doc, 'p', 'dps-stage-note');
    stageNote.setAttribute('aria-live', 'polite');
    const dockParts = buildDock(doc);
    const dockHost = el(doc, 'div', 'dps-stage-dock');
    dockHost.append(dockParts.dock);
    const customBtn = button(doc, 'dps-btn dps-stage-custom', '自定义', { 'aria-expanded': 'false' });
    const hiddenTag = el(doc, 'span', 'dps-stage-tag', '已隐藏');
    stage.append(floor, figure, hiddenTag, dockHost, stageNote, customBtn);

    // 自定义：大小、形象文件夹（展开收起有高度过渡）
    const drawer = el(doc, 'div', 'dps-drawer');
    const drawerInner = el(doc, 'div', 'dps-drawer-inner');
    const sizeRow = el(doc, 'div', 'dps-row');
    const sizeCopy = el(doc, 'span', 'dps-row-copy');
    const sizeTitle = el(doc, 'span', 'dps-row-title', '大小');
    sizeCopy.append(sizeTitle, el(doc, 'span', 'dps-row-hint', `也可以把鼠标放在角色上，按住 ${IS_MAC ? 'Cmd' : 'Ctrl'} 滚动滚轮。每个助手的大小分别记住。`));
    const sizeControl = el(doc, 'span', 'dps-size');
    const slider = el(doc, 'input', 'dps-slider');
    slider.type = 'range';
    slider.step = '0.05';
    slider.setAttribute('aria-label', '桌宠大小');
    const sizeValue = el(doc, 'span', 'dps-size-value');
    sizeControl.append(slider, sizeValue);
    sizeRow.append(sizeCopy, sizeControl);
    const folderRow = el(doc, 'div', 'dps-row');
    const folderCopy = el(doc, 'span', 'dps-row-copy');
    const folderHint = el(doc, 'span', 'dps-row-hint');
    folderCopy.append(el(doc, 'span', 'dps-row-title', '形象文件夹'), folderHint);
    const folderBtn = button(doc, 'dps-btn', '打开文件夹');
    folderRow.append(folderCopy, folderBtn);
    drawerInner.append(sizeRow, folderRow);
    drawer.append(drawerInner);

    const head = el(doc, 'div', 'dps-head');
    const headTitle = el(doc, 'h4', 'dps-subtitle', '我的桌宠');
    const agentSelect = el(doc, 'select', 'dps-agent');
    agentSelect.setAttribute('aria-label', '选择助手');
    // 自己管样式和行为：设置页的下拉投影不接管它
    agentSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    const spacer = el(doc, 'span', 'dps-spacer');
    const refreshBtn = button(doc, 'dps-icon-btn', undefined, { title: '重新扫描形象、重画预览', 'aria-label': '刷新' });
    refreshBtn.append(icon(doc, 'refresh'));
    const importBtn = button(doc, 'dps-btn', '导入形象', { title: '选 Live2D 模型（.model3.json）、网格立绘（.puppet.json），或者一张/几张立绘图片' });
    head.append(headTitle, agentSelect, spacer, refreshBtn, importBtn);
    const grid = el(doc, 'div', 'dps-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', '桌宠形象');

    const optionsTitle = el(doc, 'h4', 'dps-subtitle', '选项');
    const options = el(doc, 'div', 'dps-card');
    const dnd = buildSwitchRow(doc, '免打扰', '不主动说话、不出声，主窗口里聊天的回复也不在桌宠头上冒出来。在桌宠上跟 TA 说的话照常回。');
    const restore = buildSwitchRow(doc, '启动时恢复桌宠', '打开 VCPChat 时，把上次开着的桌宠放回原来的位置。');
    options.append(dnd.row, restore.row);

    const shortcutsTitle = el(doc, 'h4', 'dps-subtitle', '快捷键');
    const shortcuts = el(doc, 'div', 'dps-card');
    const shortcutHint = el(doc, 'p', 'dps-row-hint dps-card-hint', '在任何程序里都能用。点一下按钮，再按下想要的组合键；Esc 取消，Backspace 清除。');
    const shortcutList = el(doc, 'div', 'dps-shortcuts');
    const resetRow = el(doc, 'div', 'dps-card-actions');
    const resetBtn = button(doc, 'dps-btn', '恢复默认快捷键');
    resetRow.append(resetBtn);
    shortcuts.append(shortcutHint, shortcutList, resetRow);

    root.append(intro, stage, drawer, head, grid, optionsTitle, options, shortcutsTitle, shortcuts);

    // 设置表单的自动保存不碰这里的控件
    const keepInside = (e) => e.stopPropagation();
    root.addEventListener('input', keepInside);
    root.addEventListener('change', keepInside);
    root.addEventListener('submit', keepInside);

    const api = getApi(doc);
    if (!api) {
        lead.textContent = '桌宠设置只能在 VCPChat 里打开。';
        return root;
    }
    const win = doc.defaultView;

    // ---- 状态 ----
    const state = {
        snapshot: null,
        catalog: null,
        agentId: null,
        recording: null, // 正在录快捷键的动作 id
        errors: {},
        drawerOpen: false,
        voice: null,
        visible: false,
        loadSeq: 0,
        shownOutfit: undefined,
    };

    // ---- 大预览 ----

    // 换形象时旧图下沉淡出、新图从脚下弹起来；同一张不重播
    function showFigure(url, key) {
        if (state.shownOutfit === key && figure.querySelector('.dps-figure:not(.is-leaving)')?.dataset.src === (url || '')) return;
        state.shownOutfit = key;
        for (const old of figure.querySelectorAll('.dps-figure:not(.is-leaving)')) {
            old.classList.add('is-leaving');
            setTimeout(() => old.remove(), 420);
        }
        if (!key) return;
        const node = el(doc, 'div', 'dps-figure is-entering');
        node.dataset.src = url || '';
        if (url) {
            const img = el(doc, 'img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.src = url;
            node.append(img);
        } else {
            node.classList.add('is-loading');
        }
        figure.append(node);
        requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('is-entering')));
    }

    function currentItem() {
        const c = state.catalog;
        return c?.outfits?.find((o) => o.id === c.outfit) || null;
    }

    function renderStage() {
        const c = state.catalog;
        const item = currentItem();
        stage.dataset.state = !c?.agentId ? 'empty' : item ? (c.visible ? 'shown' : 'hidden') : 'none';
        showFigure(item?.preview || null, item ? `${c.agentId}\n${item.id}` : null);
        const name = c?.name || 'TA';
        dockParts.input.placeholder = `和 ${name} 说点什么…`;
        customBtn.hidden = !c?.agentId;
    }

    function note(text, { error = false, ms = 3200 } = {}) {
        stageNote.textContent = text;
        stageNote.classList.toggle('is-error', error);
        stageNote.classList.add('is-shown');
        clearTimeout(note.timer);
        note.timer = setTimeout(() => stageNote.classList.remove('is-shown'), ms);
    }

    // ---- 预览里的小胶囊：和桌面上一样的三态 ----

    function setDock(mode) {
        dockParts.dock.dataset.mode = mode;
        stage.dataset.dock = mode;
        if (mode === 'bar') {
            fitInput();
            setTimeout(() => dockParts.input.focus({ preventScroll: true }), 80);
        }
    }

    function fitInput() {
        const input = dockParts.input;
        input.style.height = 'auto';
        const height = Math.min(96, Math.max(36, input.scrollHeight || 36));
        input.style.height = `${height}px`;
        dockParts.dock.style.setProperty('--dock-bar-h', `${height + 12}px`);
        dockParts.send.classList.toggle('is-empty', !input.value.trim());
    }

    async function sendFromStage() {
        const text = dockParts.input.value.trim();
        if (!text || !state.catalog?.agentId) return;
        dockParts.send.disabled = true;
        try {
            const result = await api.talkToDeskPet(state.catalog.agentId, text);
            if (result?.success) {
                dockParts.input.value = '';
                fitInput();
                setDock('pill');
                note(`发给桌面上的 ${state.catalog.name} 了，回复显示在 TA 头上`);
            } else {
                note(`没发出去：${result?.error || '未知原因'}`, { error: true });
            }
        } finally {
            dockParts.send.disabled = false;
        }
    }

    async function voice() {
        if (!state.voice) {
            const { createDictation } = await import('../../../DeskPetmodules/dictation.js');
            state.voice = createDictation({
                status: () => api.getLocalSttStatus(),
                transcribe: (wav, language) => api.transcribeLocalStt({ wav, language }),
                onLevel: (level) => dockParts.stop.style.setProperty('--level', level.toFixed(2)),
            });
        }
        return state.voice;
    }

    async function startVoice() {
        const dictation = await voice().catch(() => null);
        if (!dictation || dictation.active || dictation.starting || dockParts.stop.classList.contains('is-busy')) return;
        const from = dockParts.dock.dataset.mode;
        setDock('rec');
        try {
            await dictation.start();
            dictation.onLimit(() => finishVoice());
        } catch (error) {
            if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
            note(error.message, { error: true, ms: 6000 });
            setDock(from === 'bar' ? 'bar' : 'pill');
        }
    }

    async function finishVoice() {
        const dictation = state.voice;
        // 麦克风还没打开就点了停：当作取消
        if (dictation?.starting) {
            dictation.cancel();
            setDock(dockParts.input.value.trim() ? 'bar' : 'pill');
            return;
        }
        if (!dictation?.active || dockParts.stop.classList.contains('is-busy')) return;
        dockParts.stop.classList.add('is-busy');
        let text = '';
        try {
            text = await dictation.stop();
        } catch (error) {
            note(error.message, { error: true });
        } finally {
            dockParts.stop.classList.remove('is-busy');
        }
        if (dockParts.dock.dataset.mode !== 'rec') return;
        const input = dockParts.input;
        if (text) input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
        else if (!input.value.trim()) note('没听到说话');
        setDock(input.value.trim() ? 'bar' : 'pill');
    }

    function cancelVoice() {
        state.voice?.cancel();
    }

    dockParts.edit.addEventListener('click', () => setDock('bar'));
    dockParts.recEdit.addEventListener('click', () => { cancelVoice(); setDock('bar'); });
    dockParts.voice.addEventListener('click', startVoice);
    dockParts.mic.addEventListener('click', startVoice);
    dockParts.stop.addEventListener('click', finishVoice);
    dockParts.send.addEventListener('click', sendFromStage);
    dockParts.bar.addEventListener('submit', (e) => { e.preventDefault(); sendFromStage(); });
    dockParts.input.addEventListener('input', fitInput);
    dockParts.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendFromStage();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // 别把整个设置关了
            setDock('pill');
        }
    });
    dockParts.dock.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dockParts.dock.dataset.mode === 'rec') {
            e.preventDefault();
            e.stopPropagation();
            cancelVoice();
            setDock('pill');
        }
    });
    // 设置页的 Esc 在 document 捕获阶段就把整个设置关了；输入条 / 录音条展开时，
    // 先在 window 捕获阶段标记掉，Esc 只收回胶囊（上面两个 keydown 照常处理）
    win?.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || dockParts.dock.dataset.mode === 'pill' || !dockParts.dock.contains(e.target)) return;
        e.preventDefault();
    }, true);
    // 点到预览外面、输入条是空的：收回小胶囊
    doc.addEventListener('pointerdown', (e) => {
        if (dockParts.dock.dataset.mode === 'bar' && !dockParts.input.value.trim() && !dockParts.dock.contains(e.target)) setDock('pill');
    });

    // ---- 自定义抽屉 ----

    function setDrawer(open) {
        state.drawerOpen = open;
        drawer.classList.toggle('is-open', open);
        customBtn.setAttribute('aria-expanded', String(open));
        customBtn.classList.toggle('is-active', open);
    }
    customBtn.addEventListener('click', () => setDrawer(!state.drawerOpen));

    function percent(scale) {
        return `${Math.round(scale * 100)}%`;
    }

    function renderDrawer() {
        const c = state.catalog;
        if (!c?.agentId) return;
        const range = state.snapshot?.scale || { min: 0.5, max: 2 };
        slider.min = String(range.min);
        slider.max = String(c.maxScale ?? range.max);
        if (doc.activeElement !== slider) {
            slider.value = String(c.scale);
            sizeValue.textContent = percent(c.scale);
        }
        sizeTitle.textContent = `${c.name} 的大小`;
        folderHint.textContent = `往里面放 Live2D 模型、网格立绘或立绘图片，每个子文件夹是一套形象：${c.folder}`;
    }

    let pendingScale = null;
    let pushingScale = false;
    async function pushScale() {
        if (pushingScale || pendingScale === null || !state.catalog?.agentId) return;
        pushingScale = true;
        const scale = pendingScale;
        pendingScale = null;
        try { await api.setDeskPetScale(state.catalog.agentId, scale); } finally { pushingScale = false; }
        pushScale();
    }
    slider.addEventListener('input', () => {
        sizeValue.textContent = percent(Number(slider.value));
        pendingScale = Number(slider.value);
        pushScale();
    });
    folderBtn.addEventListener('click', () => state.catalog?.agentId && api.openDeskPetFolder(state.catalog.agentId));

    // ---- 卡片 ----

    function cardFor(item) {
        const card = button(doc, 'dps-pet-card', undefined, { role: 'radio' });
        card.dataset.outfit = item ? item.id : '';
        const art = el(doc, 'span', 'dps-pet-art');
        if (!item) {
            // 「无」：只有一个小胶囊，和桌面上什么都不放时一样
            const mini = el(doc, 'span', 'dps-mini-pill');
            mini.append(icon(doc, 'edit'), el(doc, 'i'), icon(doc, 'voice'));
            art.append(mini);
        } else {
            art.classList.add('is-loading');
            const img = el(doc, 'img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.addEventListener('load', () => art.classList.remove('is-loading'));
            art.append(img);
        }
        const name = el(doc, 'span', 'dps-pet-name', item ? item.name : '无');
        const desc = el(doc, 'span', 'dps-pet-desc', item ? item.description : '不放桌宠，只用主窗口');
        card.append(art, name, desc);
        if (item?.kindLabel && item.kindLabel !== item.name) card.append(el(doc, 'span', 'dps-pet-kind', item.kindLabel));
        card.addEventListener('click', () => choose(item ? item.id : ''));
        return card;
    }

    function setCardPreview(card, url) {
        const img = card.querySelector('.dps-pet-art img');
        if (!img) return;
        const art = card.querySelector('.dps-pet-art');
        if (!url) {
            art.classList.remove('is-loading');
            art.classList.add('is-failed');
            return;
        }
        if (img.getAttribute('src') === url) return;
        art.classList.add('is-loading');
        img.src = url;
    }

    function renderGrid(fresh) {
        const c = state.catalog;
        if (fresh) {
            grid.replaceChildren();
            if (!c?.agentId) {
                grid.append(el(doc, 'p', 'dps-empty', '还没有助手。先在左边建一个 Agent。'));
                return;
            }
            const cards = [cardFor(null), ...c.outfits.map(cardFor)];
            cards.forEach((card, i) => {
                card.style.setProperty('--i', String(i));
                grid.append(card);
            });
            if (!c.outfits.length) {
                const empty = el(doc, 'p', 'dps-empty', '这个助手还没有形象：现在显示的是头像。点「导入形象」放一个 Live2D 模型或一张立绘进来。');
                grid.append(empty);
            }
        }
        for (const card of grid.querySelectorAll('.dps-pet-card')) {
            const id = card.dataset.outfit;
            const selected = (c?.outfit || '') === id;
            card.classList.toggle('is-selected', selected);
            card.setAttribute('aria-checked', String(selected));
            card.disabled = state.choosing === true;
            const item = c?.outfits?.find((o) => o.id === id);
            if (item?.preview) setCardPreview(card, item.preview);
        }
    }

    async function choose(outfitId) {
        const c = state.catalog;
        if (!c?.agentId || state.choosing) return;
        if ((c.outfit || '') === outfitId && (outfitId === '' || c.visible)) return;
        state.choosing = true;
        // 先在界面上换过去（卡片选中、大预览换图），主进程那边慢慢开窗口
        c.outfit = outfitId || null;
        c.visible = Boolean(outfitId);
        renderGrid(false);
        renderStage();
        try {
            const result = await api.chooseDeskPetOutfit(c.agentId, outfitId);
            if (result?.success === false) note(result.error || '没换成', { error: true });
            if (result?.catalog && result.catalog.agentId === state.agentId) applyCatalog(result.catalog);
        } finally {
            state.choosing = false;
            renderGrid(false);
        }
    }

    // ---- 助手、显示隐藏、导入、刷新 ----

    function renderAgents() {
        const c = state.catalog;
        const agents = c?.agents || [];
        const key = JSON.stringify(agents.map((a) => [a.id, a.name]));
        if (agentSelect.dataset.options !== key) {
            agentSelect.dataset.options = key;
            agentSelect.replaceChildren(...agents.map((agent) => {
                const option = el(doc, 'option', '', agent.name);
                option.value = agent.id;
                return option;
            }));
        }
        agentSelect.value = c?.agentId || '';
        agentSelect.hidden = agents.length < 2;
    }

    function renderIntro() {
        const shortcutsNow = state.snapshot?.settings?.shortcuts || {};
        const toggleKey = formatAccelerator(shortcutsNow.toggle);
        const talkKey = formatAccelerator(shortcutsNow.talk);
        const parts = ['桌宠让助手待在桌面上，光标停在 TA 身上就能打字或说话。'];
        if (toggleKey) parts.push(`按下 ${toggleKey} 显示或隐藏桌宠`);
        if (talkKey) parts.push(`${toggleKey ? '，' : '按下 '}${talkKey} 叫出 TA 并打开输入框`);
        lead.textContent = `${parts.join('')}${toggleKey || talkKey ? '。' : ''}`;
        const anyVisible = Boolean(state.catalog?.anyVisible);
        visibleBtn.textContent = anyVisible ? '隐藏桌宠' : '显示桌宠';
        visibleBtn.disabled = !state.catalog?.agentId;
    }

    function applyCatalog(catalog, { fresh = false } = {}) {
        const switched = state.catalog?.agentId !== catalog?.agentId;
        state.catalog = catalog;
        state.agentId = catalog?.agentId || null;
        const ids = JSON.stringify((catalog?.outfits || []).map((o) => o.id));
        const rebuild = fresh || switched || grid.dataset.ids !== ids;
        grid.dataset.ids = ids;
        renderAgents();
        renderIntro();
        renderStage();
        renderDrawer();
        renderGrid(rebuild);
    }

    async function loadCatalog(agentId = state.agentId, { refresh = false } = {}) {
        const seq = ++state.loadSeq;
        root.classList.toggle('is-busy', true);
        try {
            const catalog = await (refresh ? api.refreshDeskPetCatalog(agentId) : api.getDeskPetCatalog(agentId));
            if (seq !== state.loadSeq || !catalog) return;
            applyCatalog(catalog, { fresh: refresh });
        } finally {
            if (seq === state.loadSeq) root.classList.toggle('is-busy', false);
        }
    }

    let reloadTimer = 0;
    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { if (state.visible && !state.choosing) loadCatalog(); }, CATALOG_DEBOUNCE_MS);
    }

    agentSelect.addEventListener('change', () => {
        cancelVoice();
        setDock('pill');
        state.shownOutfit = undefined;
        loadCatalog(agentSelect.value);
    });
    visibleBtn.addEventListener('click', async () => {
        visibleBtn.disabled = true;
        try {
            const catalog = await api.setDeskPetsVisible(!state.catalog?.anyVisible, state.agentId);
            if (catalog) applyCatalog(catalog);
        } finally {
            visibleBtn.disabled = false;
        }
    });
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('is-spinning');
        try { await loadCatalog(state.agentId, { refresh: true }); } finally { setTimeout(() => refreshBtn.classList.remove('is-spinning'), 500); }
    });
    importBtn.addEventListener('click', async () => {
        if (!state.agentId) return;
        importBtn.disabled = true;
        try {
            const result = await api.importDeskPetOutfit(state.agentId);
            if (result?.catalog) applyCatalog(result.catalog);
            if (result?.success) note(`导入好了，${state.catalog?.name || 'TA'} 已经换上「${result.outfitId}」`);
            else if (!result?.canceled && result?.error) note(result.error, { error: true, ms: 6000 });
        } finally {
            importBtn.disabled = false;
        }
    });

    // ---- 选项和快捷键 ----

    function renderSwitches() {
        const settings = state.snapshot?.settings;
        if (!settings) return;
        dnd.input.checked = settings.doNotDisturb === true;
        restore.input.checked = settings.restoreOnLaunch === true;
    }

    async function update(patch) {
        const snapshot = await api.updateDeskPetSettings(patch);
        if (snapshot) applySnapshot(snapshot);
    }
    dnd.input.addEventListener('change', () => update({ doNotDisturb: dnd.input.checked }));
    restore.input.addEventListener('change', () => update({ restoreOnLaunch: restore.input.checked }));

    function renderShortcuts() {
        const snapshot = state.snapshot;
        if (!snapshot) return;
        shortcutList.replaceChildren();
        for (const [actionId, action] of Object.entries(snapshot.actions)) {
            const row = el(doc, 'div', 'dps-row dps-shortcut');
            const label = el(doc, 'span', 'dps-row-title', action.label);
            const accelerator = snapshot.settings.shortcuts[actionId];
            const recording = state.recording === actionId;
            const key = button(doc, 'dps-key', recording ? '请按下组合键…' : (formatAccelerator(accelerator) || '未设置'));
            key.classList.toggle('is-recording', recording);
            key.classList.toggle('is-empty', !accelerator && !recording);
            key.addEventListener('click', () => (recording ? stopRecording() : startRecording(actionId)));
            key.addEventListener('keydown', (e) => onRecordKey(e, actionId));
            const error = el(doc, 'span', 'dps-key-error', state.errors[actionId] || (snapshot.paused ? '' : snapshot.failures?.[actionId] || ''));
            row.append(label, error, key);
            shortcutList.append(row);
            if (recording) key.focus({ preventScroll: true });
        }
    }

    async function startRecording(actionId) {
        state.recording = actionId;
        delete state.errors[actionId];
        // 录的时候先停掉现有的全局快捷键，否则按下去直接触发了
        applySnapshot(await api.pauseDeskPetShortcuts(true));
    }

    async function stopRecording() {
        if (!state.recording) return;
        state.recording = null;
        applySnapshot(await api.pauseDeskPetShortcuts(false));
    }

    async function onRecordKey(e, actionId) {
        if (state.recording !== actionId) return;
        e.preventDefault();
        e.stopPropagation();
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (plain && e.key === 'Escape') return stopRecording();
        let accelerator;
        if (plain && (e.key === 'Backspace' || e.key === 'Delete')) accelerator = '';
        else {
            accelerator = acceleratorFromEvent(e);
            if (accelerator === null) return; // 只按了修饰键，继续等
        }
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        const result = await api.setDeskPetShortcut(actionId, accelerator);
        if (result?.success) delete state.errors[actionId];
        else state.errors[actionId] = result?.error || '设置失败';
        applySnapshot(result?.snapshot || (await api.getDeskPetSettings()));
    }

    resetBtn.addEventListener('click', async () => {
        state.errors = {};
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        applySnapshot(await api.resetDeskPetShortcuts());
    });

    function applySnapshot(snapshot) {
        if (!snapshot) return;
        const before = JSON.stringify(state.snapshot?.pets || null);
        state.snapshot = snapshot;
        renderSwitches();
        renderShortcuts();
        renderIntro();
        // 桌宠开了、关了、换了装、改了大小（右键菜单、托盘、快捷键）：卡片和预览跟着变
        if (before !== JSON.stringify(snapshot.pets || null)) scheduleReload();
    }

    // ---- 生命周期：分区显示出来才拉数据、才渲染快照 ----

    const unsubscribe = [
        api.onDeskPetSettingsChanged?.((snapshot) => {
            if (!root.isConnected) return;
            applySnapshot(snapshot);
        }),
        api.onDeskPetPreview?.(({ agentId, outfitId, url } = {}) => {
            if (!root.isConnected || agentId !== state.agentId || !state.catalog) return;
            const item = state.catalog.outfits.find((o) => o.id === outfitId);
            if (!item) return;
            item.preview = url || null;
            const card = [...grid.querySelectorAll('.dps-pet-card')].find((node) => node.dataset.outfit === outfitId);
            if (card) setCardPreview(card, url);
            if (state.catalog.outfit === outfitId) renderStage();
        }),
    ].filter(Boolean);

    function onShown() {
        state.visible = true;
        api.getDeskPetSettings().then(applySnapshot).catch(() => {});
        loadCatalog().catch((error) => note(`读不到桌宠：${error.message}`, { error: true }));
    }

    function onHidden() {
        state.visible = false;
        cancelVoice();
        if (dockParts.dock.dataset.mode !== 'bar' || !dockParts.input.value.trim()) setDock('pill');
        if (state.recording) stopRecording();
    }

    if (typeof win.IntersectionObserver === 'function') {
        const observer = new win.IntersectionObserver((entries) => {
            if (!root.isConnected) {
                observer.disconnect();
                for (const off of unsubscribe) off?.();
                return;
            }
            const shown = entries.some((entry) => entry.isIntersecting);
            if (shown && !state.visible) onShown();
            else if (!shown && state.visible) onHidden();
        });
        observer.observe(root);
    } else {
        onShown();
    }

    // 切到别的窗口时停止录快捷键，也把暂停的快捷键恢复
    win.addEventListener('blur', () => { if (state.recording) stopRecording(); });
    renderStage();
    renderIntro();
    return root;
}
