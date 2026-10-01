/**
 * modules/ui-system/command-center.js
 * Ctrl+K 命令中心：一个输入框同时搜命令、对话（助手/群组/话题）和工作区文件，回车直达。
 *
 * 交互与数据结构对照 ZCode 的 CommandCenterDialog / commandCenterSearchHistory
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/command-center/）：
 * 前缀切换范围（">" 命令、"#" 对话、"@" 文件），顶部范围页签，"全部" 里每组只露几条并带「查看全部」，
 * 空输入时显示最近搜索（最多 20 条、按查询去重）。ZCode 的数据来自 CLI 的任务列表与文件服务；
 * 这里的三类数据都由 renderer.js 注入：应用命令、助手/群组/话题、workspaces:search 的文件索引。
 * 这是对话内查找（Ctrl+F）和聊天记录全局搜索之外的「跳转」入口，不搜消息正文。
 */

'use strict';

const HISTORY_KEY = 'vcp-command-center-search-history';
const HISTORY_LIMIT = 20;
const ALL_SCOPE_SECTION_LIMIT = 5;
const SINGLE_SCOPE_LIMIT = 30;
const ASYNC_DEBOUNCE_MS = 140;

export const SCOPES = Object.freeze([
    { id: 'all', label: '全部', prefix: '' },
    { id: 'commands', label: '命令', prefix: '>' },
    { id: 'conversations', label: '对话', prefix: '#' },
    { id: 'files', label: '文件', prefix: '@' }
]);
const SECTION_LABELS = { commands: '命令', conversations: '对话', files: '文件' };
const PREFIX_TO_SCOPE = { '>': 'commands', '#': 'conversations', '@': 'files' };

// ------------------------------------------------------------------ pure helpers

/** ">" / "#" / "@" 开头显式指定范围，其余为「全部」。 */
export function resolveQueryScope(rawQuery) {
    const trimmed = String(rawQuery || '').trimStart();
    const scope = PREFIX_TO_SCOPE[trimmed[0]];
    if (scope) return { query: trimmed.slice(1).trimStart(), scope, explicitScope: true };
    return { query: String(rawQuery || '').trim(), scope: 'all', explicitScope: false };
}

export function scopeToPrefix(scope) {
    return SCOPES.find(item => item.id === scope)?.prefix || '';
}

export function readSearchHistory(storage) {
    try {
        const parsed = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(entry => entry && typeof entry.query === 'string' && typeof entry.updatedAt === 'number'
                && SCOPES.some(scope => scope.id === entry.scope))
            .slice(0, HISTORY_LIMIT);
    } catch (_error) {
        return [];
    }
}

function writeSearchHistory(storage, entries) {
    try {
        storage?.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
    } catch (_error) {
        // 搜索历史只是快捷入口，存不下不能影响命令中心本身
    }
}

/** 新记录排最前，按查询（忽略大小写）去重，最多 HISTORY_LIMIT 条；空查询和单独的前缀不记。 */
export function pushSearchHistory(storage, query, scope, now = Date.now()) {
    const trimmed = String(query || '').trim();
    if (!trimmed || PREFIX_TO_SCOPE[trimmed]) return readSearchHistory(storage);
    const key = trimmed.toLowerCase();
    const entries = [
        { query: trimmed, scope, updatedAt: now },
        ...readSearchHistory(storage).filter(entry => entry.query.toLowerCase() !== key)
    ].slice(0, HISTORY_LIMIT);
    writeSearchHistory(storage, entries);
    return entries;
}

export function clearSearchHistory(storage) {
    writeSearchHistory(storage, []);
}

const norm = text => String(text || '').trim().toLowerCase();

/** 命令匹配：标题 > 关键词 > 说明；返回 -1 表示不匹配，越小越靠前。 */
export function scoreCommand(command, query) {
    const needle = norm(query);
    if (!needle) return 0;
    const title = norm(command.title);
    if (title === needle) return 0;
    if (title.startsWith(needle)) return 1;
    if (title.includes(needle)) return 2;
    if ((command.keywords || []).some(word => norm(word).includes(needle))) return 3;
    if (norm(command.description).includes(needle)) return 4;
    return -1;
}

export function filterCommands(commands, query) {
    return commands
        .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
        .filter(entry => entry.score >= 0)
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map(entry => entry.command);
}

/**
 * 助手/群组/话题 → 结果行。话题名命中给话题行，助手名命中给助手行（打开它最近的话题）；
 * 查询为空时只列出助手/群组。
 */
export function buildConversationItems(agents, groups, query, limit = SINGLE_SCOPE_LIMIT) {
    const needle = norm(query);
    const rows = [];
    const collect = (list, type) => {
        for (const entry of Array.isArray(list) ? list : []) {
            if (!entry?.id) continue;
            const name = entry.name || entry.id;
            const typeLabel = type === 'group' ? '群组' : '助手';
            const base = { itemId: entry.id, itemType: type, itemName: name, itemAvatar: entry.avatarUrl || null, itemConfig: entry };
            const nameScore = needle ? (norm(name) === needle ? 0 : norm(name).startsWith(needle) ? 1 : norm(name).includes(needle) ? 2 : -1) : 0;
            if (nameScore >= 0) rows.push({ id: `${type}:${entry.id}`, title: name, subtitle: typeLabel, badge: typeLabel, score: nameScore, ...base });
            if (!needle) continue;
            for (const topic of Array.isArray(entry.topics) ? entry.topics : []) {
                const topicName = topic?.name || '';
                const score = norm(topicName) === needle ? 0 : norm(topicName).startsWith(needle) ? 1 : norm(topicName).includes(needle) ? 2 : -1;
                if (score < 0) continue;
                rows.push({ id: `${type}:${entry.id}:${topic.id}`, title: topicName, subtitle: `${typeLabel} · ${name}`, badge: '话题', score: score + 0.5, topicId: topic.id, ...base });
            }
        }
    };
    collect(agents, 'agent');
    collect(groups, 'group');
    return rows.sort((a, b) => a.score - b.score).slice(0, limit);
}

export function toFileItem(file) {
    const rel = String(file?.relPath || '').replace(/\\/g, '/');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return {
        id: `file:${file?.path || rel}`,
        title: file?.name || rel.split('/').pop() || '',
        subtitle: dir ? `${file.alias}/${dir}` : String(file?.alias || ''),
        badge: String(file?.alias || '文件'),
        file
    };
}

// ------------------------------------------------------------------ controller

export function createCommandCenter({
    document: doc = document,
    storage = (() => { try { return doc.defaultView?.localStorage || null; } catch (_error) { return null; } })(),
    getCommands = () => [],
    loadConversationSources = async () => ({ agents: [], groups: [] }),
    selectConversation = async () => {},
    searchFiles = async () => [],
    openFile = async () => {},
    notify = null,
    debounceMs = ASYNC_DEBOUNCE_MS
} = {}) {
    const win = doc.defaultView;
    let overlay = null;
    let input = null;
    let tabsEl = null;
    let body = null;
    let historyEl = null;
    let manualScope = 'all';
    let rows = []; // 扁平的可选结果行（DOM 顺序）
    let activeIndex = 0;
    let isOpen = false;
    let previousFocus = null;
    let asyncTimer = null;
    let sequence = 0;
    let sources = null; // { agents, groups }
    let conversationItems = [];
    let fileItems = [];
    let loading = { conversations: false, files: false };
    let expandedScopeNote = false;
    let disposed = false;
    const cleanups = [];

    const resolved = () => resolveQueryScope(input?.value || '');
    const activeScope = () => { const r = resolved(); return r.explicitScope ? r.scope : manualScope; };

    function h(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // -------- rendering
    function renderTabs() {
        tabsEl.textContent = '';
        const current = activeScope();
        for (const scope of SCOPES) {
            const tab = h('button', 'vcp-cc-tab', scope.label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', scope.id === current ? 'true' : 'false');
            tab.dataset.scope = scope.id;
            tab.classList.toggle('active', scope.id === current);
            tab.addEventListener('mousedown', event => event.preventDefault());
            tab.addEventListener('click', () => setScope(scope.id));
            tabsEl.append(tab);
        }
    }

    function setScope(scope) {
        const r = resolved();
        manualScope = scope;
        if (r.explicitScope) input.value = r.query; // 范围改由页签决定，去掉输入里的前缀
        input.focus();
        refresh();
    }

    function renderHistory(show) {
        historyEl.textContent = '';
        historyEl.hidden = true;
        if (!show) return;
        const entries = readSearchHistory(storage);
        if (entries.length === 0) return;
        historyEl.hidden = false;
        historyEl.append(h('span', 'vcp-cc-history-title', '最近搜索'));
        for (const entry of entries) {
            const chip = h('button', 'vcp-cc-chip');
            chip.type = 'button';
            const prefix = scopeToPrefix(entry.scope);
            if (prefix) chip.append(h('span', 'vcp-cc-chip-prefix', prefix));
            chip.append(doc.createTextNode(entry.query));
            chip.addEventListener('mousedown', event => event.preventDefault());
            chip.addEventListener('click', () => {
                input.value = `${prefix}${entry.query}`;
                input.focus();
                refresh();
            });
            historyEl.append(chip);
        }
        const clear = h('button', 'vcp-cc-chip vcp-cc-chip-clear', '清除');
        clear.type = 'button';
        clear.addEventListener('mousedown', event => event.preventDefault());
        clear.addEventListener('click', () => { clearSearchHistory(storage); renderHistory(true); });
        historyEl.append(clear);
    }

    function addRow(container, item, extraClass = '') {
        const row = h('div', `vcp-cc-row ${extraClass}`.trim());
        row.setAttribute('role', 'option');
        row.dataset.itemId = item.id;
        const text = h('div', 'vcp-cc-row-text');
        text.append(h('div', 'vcp-cc-row-title', item.title));
        if (item.subtitle) text.append(h('div', 'vcp-cc-row-sub', item.subtitle));
        row.append(text);
        if (item.badge) row.append(h('span', 'vcp-cc-badge', item.badge));
        const index = rows.length;
        rows.push(item);
        row.addEventListener('mousemove', () => { if (activeIndex !== index) { activeIndex = index; highlight(); } });
        row.addEventListener('mousedown', event => event.preventDefault());
        row.addEventListener('click', () => runItem(item));
        container.append(row);
    }

    function addSection(sectionId, items, { total, isLoading, limit }) {
        const section = h('section', 'vcp-cc-section');
        section.dataset.section = sectionId;
        section.append(h('div', 'vcp-cc-section-title', SECTION_LABELS[sectionId]));
        const shown = items.slice(0, limit);
        shown.forEach(item => addRow(section, { ...item, section: sectionId }));
        if (isLoading && items.length === 0) section.append(h('div', 'vcp-cc-empty', '搜索中…'));
        if (total > shown.length) {
            const more = h('div', 'vcp-cc-more');
            more.dataset.moreScope = sectionId;
            more.textContent = `查看全部 ${total} 项`;
            more.addEventListener('mousedown', event => event.preventDefault());
            more.addEventListener('click', () => setScope(sectionId));
            section.append(more);
        }
        if (items.length === 0 && !isLoading) return null;
        return section;
    }

    function render() {
        if (!isOpen || disposed) return;
        const { query } = resolved();
        const scope = activeScope();
        const hasQuery = query.length > 0;
        renderTabs();
        renderHistory(!hasQuery);
        body.textContent = '';
        rows = [];

        const limit = scope === 'all' ? ALL_SCOPE_SECTION_LIMIT : SINGLE_SCOPE_LIMIT;
        const sections = [];
        if (scope === 'all' || scope === 'commands') {
            const matched = filterCommands(getCommands(), query).map(command => ({ id: `cmd:${command.id}`, title: command.title, subtitle: command.description, badge: command.shortcut || '', command }));
            sections.push(addSection('commands', matched, { total: matched.length, isLoading: false, limit }));
        }
        if ((scope === 'all' && hasQuery) || scope === 'conversations') {
            sections.push(addSection('conversations', conversationItems, { total: conversationItems.length, isLoading: loading.conversations, limit }));
        }
        if ((scope === 'all' && hasQuery) || (scope === 'files' && hasQuery)) {
            sections.push(addSection('files', fileItems, { total: fileItems.length, isLoading: loading.files, limit }));
        }
        sections.filter(Boolean).forEach(section => body.append(section));
        if (scope === 'files' && !hasQuery) body.append(h('div', 'vcp-cc-empty', '输入文件名，在已登记的工作区里查找。'));
        if (rows.length === 0 && !body.querySelector('.vcp-cc-empty')) body.append(h('div', 'vcp-cc-empty', hasQuery ? '没有找到匹配的结果' : '暂无内容'));
        activeIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));
        highlight();
    }

    function highlight() {
        const nodes = body.querySelectorAll('.vcp-cc-row');
        nodes.forEach((node, index) => {
            const active = index === activeIndex;
            node.classList.toggle('active', active);
            node.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) node.scrollIntoView?.({ block: 'nearest' });
        });
    }

    // -------- data
    async function ensureSources() {
        if (sources) return sources;
        try {
            const loaded = await loadConversationSources();
            sources = { agents: loaded?.agents || [], groups: loaded?.groups || [] };
        } catch (error) {
            console.warn('[CommandCenter] failed to load conversations:', error);
            sources = { agents: [], groups: [] };
        }
        return sources;
    }

    function refresh() {
        if (!isOpen) return;
        const { query } = resolved();
        const scope = activeScope();
        const mine = ++sequence;
        win.clearTimeout(asyncTimer);
        const wantConversations = (scope === 'all' && query) || scope === 'conversations';
        const wantFiles = (scope === 'all' || scope === 'files') && query;
        if (!wantConversations) conversationItems = [];
        if (!wantFiles) fileItems = [];
        loading = { conversations: Boolean(wantConversations), files: Boolean(wantFiles) };
        activeIndex = 0;
        render();
        if (!wantConversations && !wantFiles) return;
        asyncTimer = win.setTimeout(async () => {
            const tasks = [];
            if (wantConversations) {
                tasks.push(ensureSources().then((data) => {
                    if (mine !== sequence) return;
                    conversationItems = buildConversationItems(data.agents, data.groups, query);
                    loading.conversations = false;
                }));
            }
            if (wantFiles) {
                tasks.push(Promise.resolve().then(() => searchFiles(query)).then((files) => {
                    if (mine !== sequence) return;
                    fileItems = (Array.isArray(files) ? files : []).map(toFileItem);
                    loading.files = false;
                }).catch((error) => {
                    console.warn('[CommandCenter] file search failed:', error);
                    if (mine === sequence) { fileItems = []; loading.files = false; }
                }));
            }
            await Promise.all(tasks);
            if (mine === sequence) { const keep = activeIndex; render(); activeIndex = Math.min(keep, Math.max(0, rows.length - 1)); highlight(); }
        }, debounceMs);
    }

    // -------- actions
    async function runItem(item) {
        if (!item) return false;
        const { query } = resolved();
        pushSearchHistory(storage, query ? `${query}` : '', activeScope());
        close();
        try {
            if (item.command) await item.command.run?.();
            else if (item.itemId) await selectConversation(item);
            else if (item.file) await openFile(item.file);
        } catch (error) {
            console.error('[CommandCenter] action failed:', error);
            notify?.(`操作失败：${error?.message || error}`, 'error');
        }
        return true;
    }

    function moveActive(delta) {
        if (rows.length === 0) return;
        activeIndex = (activeIndex + delta + rows.length) % rows.length;
        highlight();
    }

    function cycleScope(step) {
        const index = SCOPES.findIndex(scope => scope.id === activeScope());
        setScope(SCOPES[(index + step + SCOPES.length) % SCOPES.length].id);
    }

    function onInputKeydown(event) {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
        else if (event.key === 'Enter') { event.preventDefault(); runItem(rows[activeIndex]); }
        else if (event.key === 'Tab') { event.preventDefault(); cycleScope(event.shiftKey ? -1 : 1); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }

    function open(initialQuery = '') {
        if (disposed || !overlay) return false;
        if (isOpen) { input.focus(); input.select(); return true; }
        isOpen = true;
        previousFocus = doc.activeElement;
        manualScope = 'all';
        sources = null; // 每次打开重新读，话题可能刚新建/改名
        overlay.hidden = false;
        input.value = initialQuery;
        refresh();
        input.focus();
        input.select();
        return true;
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        sequence += 1;
        win.clearTimeout(asyncTimer);
        overlay.hidden = true;
        const target = previousFocus;
        previousFocus = null;
        if (target?.isConnected && typeof target.focus === 'function') target.focus();
    }

    function toggle() { return isOpen ? close() : open(); }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (overlay || disposed || !doc.body) return overlay;
        overlay = h('div', 'vcp-cc-overlay zc-scope vcp-ui-scope');
        overlay.hidden = true;
        const dialog = h('div', 'vcp-cc-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', '命令中心');
        input = h('input', 'vcp-cc-input');
        input.type = 'text';
        input.spellcheck = false;
        input.placeholder = '搜索命令、对话、文件…（> 命令　# 对话　@ 文件）';
        input.setAttribute('aria-label', '命令中心搜索');
        tabsEl = h('div', 'vcp-cc-tabs');
        tabsEl.setAttribute('role', 'tablist');
        historyEl = h('div', 'vcp-cc-history');
        body = h('div', 'vcp-cc-body');
        body.setAttribute('role', 'listbox');
        const footer = h('div', 'vcp-cc-footer', '↑↓ 选择　Enter 打开　Tab 切换范围　Esc 关闭');
        dialog.append(input, tabsEl, historyEl, body, footer);
        overlay.append(dialog);
        doc.body.appendChild(overlay);

        on(input, 'keydown', onInputKeydown);
        on(input, 'input', () => { activeIndex = 0; refresh(); });
        on(overlay, 'mousedown', (event) => { if (event.target === overlay) close(); });
        on(win, 'keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'k') {
                event.preventDefault();
                event.stopImmediatePropagation();
                toggle();
            }
        }, true);
        return overlay;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        win.clearTimeout(asyncTimer);
        cleanups.splice(0).forEach(fn => fn());
        overlay?.remove();
        overlay = null;
        isOpen = false;
    }

    return {
        mount,
        dispose,
        open,
        close,
        toggle,
        getState: () => ({ open: isOpen, scope: input ? activeScope() : 'all', query: input?.value || '', rows: rows.map(row => row.id), activeIndex })
    };
}
