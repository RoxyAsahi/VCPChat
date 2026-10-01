/**
 * modules/ui-system/slash-commands.js
 * 输入框里的斜杠命令：在空草稿开头输入 "/" 弹出命令列表，↑/↓ 选择，Enter / Tab 执行，Esc 关闭。
 *
 * 交互对照 ZCode 的 SlashCommandPlugin / slashCommandHelpers
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/slashCommands.ts 等）：
 * 只在草稿以 "/" 开头且还在输入命令名时弹出；带参数的命令选中后补成 "/名称 " 等用户继续输入，
 * 参数写完再按 Enter 才执行；无参数的命令选中即执行并清空草稿。
 * ZCode 的命令是转发给 CLI 的（/plan、/compact…），VCPChat 没有对应的后端，这里的命令都是应用内操作，
 * 由 renderer.js 传入 actions（新建话题 / 侧栏提问 / 对话内查找 / 全局搜索…）。
 *
 * 用捕获阶段监听 #messageInput 的 keydown 并 stopImmediatePropagation，
 * 命令列表打开时 Enter 不会再走到 event-listeners.js 的「发送」逻辑。
 */

'use strict';

const POPUP_GAP = 8;
const POPUP_MAX_WIDTH = 380;

// ------------------------------------------------------------------ pure helpers

/**
 * 解析草稿：
 *  - "/ne"        → { phase: 'name', query: 'ne' }（还在输入命令名）
 *  - "/find 你好" → { phase: 'args', name: 'find', args: '你好' }
 *  - 其他         → null（普通消息，不介入）
 */
export function parseSlashDraft(value) {
    const text = String(value ?? '');
    const typing = /^\/([^\s/]*)$/u.exec(text);
    if (typing) return { phase: 'name', query: typing[1] };
    const withArgs = /^\/([^\s/]+)[ \t]+([^\n]*)$/u.exec(text);
    if (withArgs) return { phase: 'args', name: withArgs[1], args: withArgs[2].trim() };
    return null;
}

function normalize(text) {
    return String(text || '').trim().toLowerCase();
}

/** 按名称前缀优先、其次名称/别名/说明包含来过滤并排序；query 为空返回全部。 */
export function filterCommands(commands, query) {
    const needle = normalize(query);
    if (!needle) return [...commands];
    const scored = [];
    commands.forEach((command, index) => {
        const names = [command.name, ...(command.aliases || [])].map(normalize);
        let score = -1;
        if (names.some(name => name === needle)) score = 0;
        else if (names.some(name => name.startsWith(needle))) score = 1;
        else if (names.some(name => name.includes(needle)) || normalize(command.label).includes(needle)) score = 2;
        else if (normalize(command.description).includes(needle)) score = 3;
        if (score >= 0) scored.push({ command, score, index });
    });
    return scored.sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.command);
}

/** 精确匹配命令名或别名。 */
export function findCommand(commands, name) {
    const needle = normalize(name);
    if (!needle) return null;
    return commands.find(command => [command.name, ...(command.aliases || [])].some(item => normalize(item) === needle)) || null;
}

/** 由 renderer 传入的 actions 生成命令表；缺少的 action 对应的命令不出现。 */
export function buildDefaultCommands(actions = {}) {
    const defs = [
        { name: 'new', aliases: ['topic', '新话题'], label: '新建话题', description: '在当前 Agent 下新建一个话题', action: 'newTopic' },
        { name: 'side', aliases: ['btw', '侧栏'], label: '侧栏提问', description: '打开侧栏辅助聊天', action: 'sideChat' },
        { name: 'find', aliases: ['f', '查找'], label: '对话内查找', description: '在当前对话里查找文字，可直接跟关键词', action: 'find', takesArgs: true, argHint: '关键词' },
        { name: 'search', aliases: ['global', '搜索'], label: '全局搜索', description: '跨话题搜索全部聊天记录', action: 'globalSearch' },
        { name: 'trace', aliases: ['trajectory', '轨迹', '调用轨迹'], label: '调用轨迹', description: '在右侧栏查看每次模型调用的请求、响应和 token 用量', action: 'modelTrajectory' },
        { name: 'export', aliases: ['导出'], label: '导出选中消息', description: '勾选消息后复制为 Markdown 或保存为 .md', action: 'exportMessages' },
        { name: 'settings', aliases: ['config', '设置'], label: '当前 Agent 设置', description: '打开当前 Agent 的设置', action: 'agentSettings' },
        { name: 'theme', aliases: ['dark', '主题'], label: '切换明暗主题', description: '在明亮 / 暗色主题之间切换', action: 'toggleTheme' }
    ];
    return defs
        .filter(def => typeof actions[def.action] === 'function')
        .map(({ action, ...def }) => ({ ...def, run: args => actions[action](args) }));
}

/** 命令列表放在输入框正上方，宽度跟随输入框但不超过上限。 */
export function resolvePopupPosition({ inputRect, viewportHeight, viewportWidth }) {
    const width = Math.max(220, Math.min(POPUP_MAX_WIDTH, inputRect.width || POPUP_MAX_WIDTH));
    const left = Math.max(8, Math.min(inputRect.left, viewportWidth - width - 8));
    return { left, width, bottom: Math.max(8, viewportHeight - inputRect.top + POPUP_GAP) };
}

// ------------------------------------------------------------------ controller

export function createSlashCommands({
    document: doc = document,
    getInput = () => doc.getElementById('messageInput'),
    actions = {},
    commands = null
} = {}) {
    const win = doc.defaultView;
    const commandList = commands || buildDefaultCommands(actions);
    let popup = null;
    let listEl = null;
    let items = [];
    let activeIndex = 0;
    let disposed = false;
    let boundInput = null;
    const cleanups = [];

    const isOpen = () => Boolean(popup && !popup.hidden);

    function setValue(input, value) {
        input.value = value;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.setSelectionRange?.(value.length, value.length);
    }

    function close() {
        if (popup) popup.hidden = true;
        items = [];
        activeIndex = 0;
    }

    function highlight() {
        if (!listEl) return;
        [...listEl.children].forEach((node, index) => {
            const active = index === activeIndex;
            node.classList.toggle('active', active);
            node.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) node.scrollIntoView?.({ block: 'nearest' });
        });
    }

    function renderItems() {
        listEl.textContent = '';
        items.forEach((command, index) => {
            const row = doc.createElement('div');
            row.className = 'vcp-slash-item';
            row.setAttribute('role', 'option');
            const name = doc.createElement('span');
            name.className = 'vcp-slash-name';
            name.textContent = `/${command.name}${command.argHint ? ` <${command.argHint}>` : ''}`;
            const label = doc.createElement('span');
            label.className = 'vcp-slash-label';
            label.textContent = command.label || '';
            label.title = command.description || '';
            row.append(name, label);
            row.addEventListener('mousedown', event => event.preventDefault()); // 不让输入框失焦
            row.addEventListener('mouseenter', () => { activeIndex = index; highlight(); });
            row.addEventListener('click', () => choose(command));
            listEl.appendChild(row);
        });
    }

    function place(input) {
        const position = resolvePopupPosition({
            inputRect: input.getBoundingClientRect(),
            viewportHeight: win.innerHeight,
            viewportWidth: win.innerWidth
        });
        popup.style.left = `${position.left}px`;
        popup.style.width = `${position.width}px`;
        popup.style.bottom = `${position.bottom}px`;
    }

    function sync() {
        const input = getInput?.();
        if (disposed || !popup || !input) return;
        const parsed = parseSlashDraft(input.value);
        if (!parsed || parsed.phase !== 'name') return close();
        const matches = filterCommands(commandList, parsed.query);
        if (matches.length === 0) return close();
        items = matches;
        activeIndex = 0; // 输入变了，高亮回到最相关的一项
        renderItems();
        popup.hidden = false;
        place(input);
        highlight();
    }

    function execute(command, args = '') {
        const input = getInput?.();
        close();
        if (input) setValue(input, '');
        try {
            const result = command.run?.(args);
            if (result && typeof result.catch === 'function') result.catch(error => console.error('[SlashCommands]', command.name, error));
        } catch (error) {
            console.error('[SlashCommands]', command.name, error);
        }
        return true;
    }

    function choose(command) {
        const input = getInput?.();
        if (!input) return false;
        if (command.takesArgs) {
            // 带参数的命令：补全成 "/名称 " 让用户继续输入，Enter 再执行
            close();
            setValue(input, `/${command.name} `);
            input.focus();
            return true;
        }
        execute(command);
        input.focus();
        return true;
    }

    function onKeydown(event) {
        if (event.isComposing || disposed) return;
        const input = event.currentTarget;
        if (isOpen()) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopImmediatePropagation();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                activeIndex = (activeIndex + step + items.length) % items.length;
                highlight();
            } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                event.preventDefault();
                event.stopImmediatePropagation();
                choose(items[activeIndex] || items[0]);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                close();
            }
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
            const parsed = parseSlashDraft(input.value);
            if (parsed?.phase === 'args') {
                const command = findCommand(commandList, parsed.name);
                // 只有声明了参数的命令才接受 "/名称 参数"；其他情况仍是一条普通消息
                if (command?.takesArgs) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    execute(command, parsed.args);
                }
            }
        }
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (popup || disposed) return popup;
        boundInput = getInput?.();
        if (!boundInput || !doc.body || commandList.length === 0) return null;
        popup = doc.createElement('div');
        popup.className = 'vcp-slash-popup';
        popup.hidden = true;
        popup.setAttribute('data-slash-command-popup', 'true');
        const heading = doc.createElement('div');
        heading.className = 'vcp-slash-heading';
        heading.textContent = '命令';
        listEl = doc.createElement('div');
        listEl.className = 'vcp-slash-list';
        listEl.setAttribute('role', 'listbox');
        popup.append(heading, listEl);
        doc.body.appendChild(popup);

        on(boundInput, 'keydown', onKeydown, true);
        on(boundInput, 'input', sync);
        on(boundInput, 'blur', close);
        on(win, 'resize', () => { if (isOpen()) place(boundInput); });
        return popup;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        cleanups.splice(0).forEach(fn => fn());
        popup?.remove();
        popup = null;
        listEl = null;
        boundInput = null;
    }

    return {
        mount,
        dispose,
        commands: commandList,
        getState: () => ({ open: isOpen(), items: items.map(item => item.name), activeIndex }),
        execute
    };
}
