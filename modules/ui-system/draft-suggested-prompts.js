/**
 * modules/ui-system/draft-suggested-prompts.js
 * 新话题（还没有任何消息）的空状态里放一排推荐提示词，点一下把提示词填进输入框（不自动发送）。
 *
 * 对应 ZCode 的 ConversationDraftSuggestedPrompts
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx）：
 * 点击只回填草稿、带「换一批」。ZCode 的推荐来自云端 Client Scenes；这里是内置的一组通用提示词，
 * 也可以用 localStorage 的 `vcp-draft-suggested-prompts`（[{ "title": "…", "prompt": "…" }]）覆盖。
 * 只观察 .main-content 上 chatManager 已经维护的 data-chat-empty-reason="empty-topic"，不改动它。
 */

'use strict';

const STORAGE_KEY = 'vcp-draft-suggested-prompts';
const VISIBLE_COUNT = 4;
const EMPTY_TOPIC_REASON = 'empty-topic';

export const DEFAULT_SUGGESTED_PROMPTS = Object.freeze([
    { title: '梳理一个想法', prompt: '我有一个想法想先梳理清楚。请先问我几个关键问题（目标、约束、现状），再给出分步方案。' },
    { title: '解释一段代码', prompt: '我想弄懂一段代码。请先用几句话说明它整体在做什么，再逐段解释关键逻辑和容易踩的坑。\n\n' },
    { title: '排查一个问题', prompt: '我遇到了一个问题。请先问我需要的背景信息，再一步步帮我定位原因。\n\n' },
    { title: '润色一段文字', prompt: '请帮我润色下面这段文字：保持原意，让表达更清晰自然，并简单说明你改了哪些地方。\n\n' },
    { title: '头脑风暴', prompt: '我们来头脑风暴一下。请围绕下面的主题给出 10 个不同方向的点子，并标出你最看好的 3 个和理由。\n\n' },
    { title: '制定学习计划', prompt: '我想学习一个新领域。请先了解我的基础和可用时间，再给我一份循序渐进的学习计划和推荐的练习。' },
    { title: '翻译并解释', prompt: '请把下面的内容翻译成中文，并对其中的专业术语或习语做简短解释。\n\n' },
    { title: '整理成周报', prompt: '请把下面零散的工作记录整理成一份条理清晰的周报：本周完成、遇到的问题、下周计划。\n\n' }
]);

// ------------------------------------------------------------------ pure helpers

/** 读取自定义推荐；格式不对、为空时回落到内置列表。 */
export function loadPromptPool(storage) {
    try {
        const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
        if (Array.isArray(parsed)) {
            const items = parsed
                .filter(item => item && typeof item.title === 'string' && typeof item.prompt === 'string')
                .map(item => ({ title: item.title.trim(), prompt: item.prompt }))
                .filter(item => item.title && item.prompt.trim());
            if (items.length > 0) return items;
        }
    } catch (_error) {
        // 坏配置按没有处理
    }
    return [...DEFAULT_SUGGESTED_PROMPTS];
}

/** 从 offset 起循环取 count 条；「换一批」就是把 offset 往后挪。 */
export function pickSuggestions(pool, count, offset = 0) {
    if (pool.length <= count) return [...pool];
    return Array.from({ length: count }, (_unused, index) => pool[(offset + index) % pool.length]);
}

/** 草稿为空就直接填，已有内容则另起一行追加，不覆盖用户正在写的东西。 */
export function applyPromptToDraft(currentValue, prompt) {
    const current = String(currentValue || '');
    if (!current.trim()) return prompt;
    return `${current}${current.endsWith('\n') ? '' : '\n'}${prompt}`;
}

// ------------------------------------------------------------------ controller

const REFRESH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createDraftSuggestedPrompts({
    document: doc = document,
    storage = (() => { try { return doc.defaultView?.localStorage || null; } catch (_error) { return null; } })(),
    getInput = () => doc.getElementById('messageInput'),
    now = () => Date.now()
} = {}) {
    const win = doc.defaultView;
    let host = null;
    let list = null;
    let observer = null;
    let offset = 0;
    let disposed = false;
    let pool = [];

    function render() {
        if (!list) return;
        list.textContent = '';
        for (const item of pickSuggestions(pool, VISIBLE_COUNT, offset)) {
            const chip = doc.createElement('button');
            chip.type = 'button';
            chip.className = 'vcp-draft-suggestion';
            chip.textContent = item.title;
            chip.title = item.prompt.trim();
            chip.addEventListener('click', () => fillDraft(item.prompt));
            list.appendChild(chip);
        }
        if (pool.length > VISIBLE_COUNT) {
            const refresh = doc.createElement('button');
            refresh.type = 'button';
            refresh.className = 'vcp-draft-suggestion vcp-draft-suggestion-refresh';
            refresh.title = '换一批推荐';
            refresh.setAttribute('aria-label', '换一批推荐');
            refresh.innerHTML = REFRESH_ICON;
            refresh.addEventListener('click', () => {
                offset = (offset + VISIBLE_COUNT) % pool.length;
                render();
            });
            list.appendChild(refresh);
        }
    }

    function fillDraft(prompt) {
        const input = getInput?.();
        if (!input || input.disabled) return false;
        input.value = applyPromptToDraft(input.value, prompt);
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        return true;
    }

    function syncVisibility() {
        if (!host || !list) return;
        const active = host.dataset.chatEmpty === 'true' && host.dataset.chatEmptyReason === EMPTY_TOPIC_REASON;
        if (active && list.hidden) {
            // 每次进入空话题从不同的位置开始，不总是同样的四条
            pool = loadPromptPool(storage);
            offset = (Math.floor(now() / 1000) % pool.length);
            render();
        }
        list.hidden = !active;
    }

    function mount() {
        if (host || disposed) return list;
        host = doc.querySelector('.main-content');
        const content = doc.querySelector('#nextUiEmptyState .next-ui-empty-state-content');
        if (!host || !content) return null;
        list = doc.createElement('div');
        list.className = 'vcp-draft-suggestions';
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', '推荐提示词');
        list.hidden = true;
        content.appendChild(list);
        if (typeof win.MutationObserver === 'function') {
            observer = new win.MutationObserver(syncVisibility);
            observer.observe(host, { attributes: true, attributeFilter: ['data-chat-empty', 'data-chat-empty-reason'] });
        }
        syncVisibility();
        return list;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        observer = null;
        list?.remove();
        list = null;
        host = null;
    }

    return { mount, dispose, fillDraft, refresh: syncVisibility };
}
