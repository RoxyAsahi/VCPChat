// 桌宠设置窗口：免打扰、启动恢复、每个桌宠的大小、全局快捷键。
// 设置的读写都在主进程（modules/deskpet/petControls.js），这里只负责显示和录键。

const api = window.deskPetSettingsAPI;
const $ = (id) => document.getElementById(id);
let state = null;
let recording = null; // { actionId, button }
const errors = {}; // actionId -> 最近一次设置失败的原因

const IS_MAC = navigator.platform.toLowerCase().includes('mac');

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

// ---- 渲染 ----

function renderSwitches() {
    $('doNotDisturb').checked = state.settings.doNotDisturb;
    $('restoreOnLaunch').checked = state.settings.restoreOnLaunch;
}

function percent(scale) {
    return `${Math.round(scale * 100)}%`;
}

function renderSizes() {
    const list = $('sizeList');
    const pets = state.pets || [];
    $('sizesEmpty').hidden = pets.length > 0;
    $('wheelHint').textContent = pets.length ? `也可以把鼠标放在角色上，按住 ${IS_MAC ? 'Cmd' : 'Ctrl'} 滚动滚轮。每个桌宠的大小分别记住。` : '';
    // 正在拖的滑块不重建，免得拖到一半被换掉
    const active = document.activeElement?.dataset?.agentId;
    const existing = new Map([...list.children].map((row) => [row.dataset.agentId, row]));
    for (const [id, row] of existing) if (!pets.some((p) => p.agentId === id)) row.remove();
    for (const pet of pets) {
        let row = existing.get(pet.agentId);
        if (!row) {
            row = document.createElement('div');
            row.className = 'row';
            row.dataset.agentId = pet.agentId;
            const name = document.createElement('span');
            name.className = 'size-name';
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.dataset.agentId = pet.agentId;
            slider.min = String(state.scale.min);
            slider.step = '0.05';
            const value = document.createElement('span');
            value.className = 'size-value';
            let pending = null;
            let busy = false;
            const push = async () => {
                if (busy || pending === null) return;
                busy = true;
                const scale = pending;
                pending = null;
                try { await api.setScale(pet.agentId, scale); } finally { busy = false; }
                push();
            };
            slider.addEventListener('input', () => {
                value.textContent = percent(Number(slider.value));
                pending = Number(slider.value);
                push();
            });
            row.append(name, slider, value);
            list.append(row);
        }
        const [name, slider, value] = row.children;
        name.textContent = pet.name;
        name.title = pet.name;
        if (!pet.visible) {
            const tag = document.createElement('span');
            tag.className = 'hidden-tag';
            tag.textContent = '（已隐藏）';
            name.append(tag);
        }
        slider.max = String(pet.maxScale ?? state.scale.max);
        slider.setAttribute('aria-label', `${pet.name} 的大小`);
        if (active !== pet.agentId) {
            slider.value = String(pet.scale);
            value.textContent = percent(pet.scale);
        }
    }
}

function renderShortcuts() {
    const list = $('shortcutList');
    list.textContent = '';
    for (const [actionId, action] of Object.entries(state.actions)) {
        const row = document.createElement('div');
        row.className = 'row shortcut';
        const label = document.createElement('span');
        label.className = 'text title';
        label.textContent = action.label;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'key';
        const accelerator = state.settings.shortcuts[actionId];
        const isRecording = recording?.actionId === actionId;
        button.classList.toggle('is-recording', isRecording);
        button.classList.toggle('is-empty', !accelerator && !isRecording);
        button.textContent = isRecording ? '请按下组合键…' : (formatAccelerator(accelerator) || '未设置');
        button.addEventListener('click', () => (isRecording ? stopRecording() : startRecording(actionId)));
        button.addEventListener('keydown', (e) => onRecordKey(e, actionId));
        const error = document.createElement('span');
        error.className = 'error';
        error.textContent = errors[actionId] || (state.paused ? '' : state.failures?.[actionId] || '');
        row.append(label, button, error);
        list.append(row);
        if (isRecording) button.focus();
    }
}

function render() {
    if (!state) return;
    renderSwitches();
    renderSizes();
    renderShortcuts();
}

// ---- 录快捷键 ----

async function startRecording(actionId) {
    recording = { actionId };
    delete errors[actionId];
    // 录的时候先停掉现有的全局快捷键，否则按下去直接触发了
    state = (await api.pauseShortcuts(true)) || state;
    render();
}

async function stopRecording() {
    if (!recording) return;
    recording = null;
    state = (await api.pauseShortcuts(false)) || state;
    render();
}

async function onRecordKey(e, actionId) {
    if (recording?.actionId !== actionId) return;
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
    recording = null;
    await api.pauseShortcuts(false);
    const result = await api.setShortcut(actionId, accelerator);
    if (result?.success) delete errors[actionId];
    else errors[actionId] = result?.error || '设置失败';
    state = result?.snapshot || (await api.get());
    render();
}

// ---- 启动 ----

async function start() {
    state = await api.get();
    $('doNotDisturb').addEventListener('change', async (e) => { state = (await api.update({ doNotDisturb: e.target.checked })) || state; render(); });
    $('restoreOnLaunch').addEventListener('change', async (e) => { state = (await api.update({ restoreOnLaunch: e.target.checked })) || state; render(); });
    $('resetShortcuts').addEventListener('click', async () => {
        for (const key of Object.keys(errors)) delete errors[key];
        recording = null;
        await api.pauseShortcuts(false);
        state = (await api.resetShortcuts()) || state;
        render();
    });
    // 切到别的窗口就不录了，也把暂停的快捷键恢复
    window.addEventListener('blur', () => stopRecording());
    api.onChanged((snapshot) => {
        state = snapshot;
        render();
    });
    render();
}

start().catch((error) => {
    document.body.textContent = `桌宠设置打不开：${error.message}`;
});
