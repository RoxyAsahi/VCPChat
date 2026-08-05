const PIPELINE_MODES = Object.freeze({
    FULL_RENDER: 'full-render',
    STREAM_FAST: 'stream-fast',
});

const PERSONA_BACKFILL_OPEN_REGEX = /<!--\s*persona_(?:delta|expression)\s*:/g;

function findPersonaJsonEnd(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) return index + 1;
    }
    return -1;
}

function stripPersonaBackfill(text) {
    if (!text || !text.includes('persona_')) return text;
    let result = '';
    let cursor = 0;
    let stripped = false;
    PERSONA_BACKFILL_OPEN_REGEX.lastIndex = 0;
    let match;
    while ((match = PERSONA_BACKFILL_OPEN_REGEX.exec(text)) !== null) {
        if (match.index < cursor) continue;
        result += text.slice(cursor, match.index);
        const jsonStart = text.indexOf('{', match.index + match[0].length);
        if (jsonStart < 0) { cursor = text.length; stripped = true; break; }
        const jsonEnd = findPersonaJsonEnd(text, jsonStart);
        if (jsonEnd < 0) { cursor = text.length; stripped = true; break; }
        const closer = text.indexOf('-->', jsonEnd);
        cursor = closer >= 0 && text.slice(jsonEnd, closer).trim() === '' ? closer + 3 : jsonEnd;
        stripped = true;
        PERSONA_BACKFILL_OPEN_REGEX.lastIndex = cursor;
    }
    return stripped ? result + text.slice(cursor) : text;
}

function normalizeAdjacentBoldBoundaries(text) {
    if (typeof text !== 'string' || !text.includes('**')) return text;
    const separator = '<!-- -->';
    const needsBoundary = (character, excluded) => Boolean(character)
        && !/\s/.test(character) && character !== excluded && character !== '*';
    let result = '';
    let cursor = 0;
    let inBold = false;
    while (cursor < text.length) {
        const markerIndex = text.indexOf('**', cursor);
        if (markerIndex < 0) return result + text.slice(cursor);
        const previous = markerIndex > 0 ? text[markerIndex - 1] : '';
        result += text.slice(cursor, markerIndex);
        if (!inBold && result && !result.endsWith(separator) && needsBoundary(previous, '<')) result += separator;
        result += '**';
        cursor = markerIndex + 2;
        inBold = !inBold;
        if (!inBold && needsBoundary(text[cursor] || '', '>')) result += separator;
    }
    return result;
}

function restoreMap(text, map) {
    let result = text;
    for (const [placeholder, original] of map || []) {
        if (result.includes(placeholder)) result = result.replace(placeholder, () => original);
    }
    return result;
}

function createAgentContentPipeline(dependencies = {}) {
    const dependency = (name) => typeof dependencies[name] === 'function'
        ? dependencies[name] : (value) => value;

    function context(input, options, mode) {
        return {
            text: typeof input === 'string' ? input : '',
            options: { ...options, mode },
            meta: { stepsApplied: [] },
            state: {
                toolResultMap: null,
                toolRequestMap: null,
                codeBlockMap: null,
                toolResultPlaceholderId: 0,
                toolRequestPlaceholderId: 0,
                codeBlockPlaceholderId: 0,
            },
        };
    }

    function step(state, name, transform) {
        state.text = transform(state.text, state) ?? state.text;
        state.meta.stepsApplied.push(name);
    }

    function regex(name) {
        return typeof dependencies[name] === 'function' ? dependencies[name]() : null;
    }

    function protectToolResults(text, state) {
        const pattern = regex('getToolResultRegex');
        if (!pattern) return text;
        pattern.lastIndex = 0;
        if (!pattern.test(text)) { pattern.lastIndex = 0; return text; }
        pattern.lastIndex = 0;
        state.state.toolResultMap = new Map();
        return text.replace(pattern, (match) => {
            const placeholder = `<!--VCP_TOOL_RESULT_${state.state.toolResultPlaceholderId++}-->`;
            state.state.toolResultMap.set(placeholder, match);
            return placeholder;
        });
    }

    function protectToolRequests(text, state) {
        if (!text.includes('<<<[TOOL_REQUEST]>>>')) return text;
        const replacer = dependencies.replaceToolRequestBlocks;
        const pattern = regex('getToolRequestRegex');
        if (typeof replacer !== 'function' && !pattern) return text;
        state.state.toolRequestMap = new Map();
        const protect = (match) => {
            const placeholder = `<!--VCP_TOOL_REQUEST_${state.state.toolRequestPlaceholderId++}-->`;
            state.state.toolRequestMap.set(placeholder, dependency('processStartEndMarkers')(match));
            return placeholder;
        };
        if (typeof replacer === 'function') return replacer(text, protect);
        pattern.lastIndex = 0;
        const result = text.replace(pattern, protect);
        pattern.lastIndex = 0;
        return result;
    }

    function protectCodeBlocks(text, state) {
        const pattern = regex('getCodeFenceRegex');
        if (!pattern || !text.includes('```')) return text;
        state.state.codeBlockMap = new Map();
        return text.replace(pattern, (match) => {
            const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${state.state.codeBlockPlaceholderId++}__`;
            state.state.codeBlockMap.set(placeholder, match);
            return placeholder;
        });
    }

    function transformDesktopPush(text) {
        const full = regex('getDesktopPushRegex');
        const partial = regex('getDesktopPushPartialRegex');
        if (!full || !partial) return text;
        const escape = dependency('escapeHtml');
        full.lastIndex = 0;
        partial.lastIndex = 0;
        let result = text.replace(full, (_match, raw) => {
            const content = String(raw || '').trim();
            const preview = escape(content.length > 120 ? `${content.slice(0, 120)}...` : content);
            return `<div class="vcp-desktop-push-placeholder"><div class="vcp-desktop-push-header"><span class="vcp-desktop-push-label">已推送到桌面画布</span></div><div class="vcp-desktop-push-preview"><pre>${preview}</pre></div></div>`;
        });
        result = result.replace(partial, (_match, raw) => {
            const content = String(raw || '').trim();
            const lines = content.split('\n');
            const preview = escape(lines.slice(-3).join('\n').slice(-120));
            return `<div class="vcp-desktop-push-placeholder constructing"><div class="vcp-desktop-push-header"><span class="vcp-desktop-push-label">正在向桌面推送${lines.length > 3 ? ` (${lines.length} 行)` : ''}<span class="thinking-indicator-dots">...</span></span></div><div class="vcp-desktop-push-preview"><pre>${preview}</pre></div></div>`;
        });
        full.lastIndex = 0;
        partial.lastIndex = 0;
        return result;
    }

    function runFullRenderPipeline(input, options = {}) {
        const state = context(input, options, PIPELINE_MODES.FULL_RENDER);
        const assistant = (options.messageRole || 'assistant') === 'assistant';
        if (assistant) step(state, 'strip-persona-backfill', stripPersonaBackfill);
        step(state, 'normalize-emoticon-urls', dependency('fixEmoticonUrlsInMarkdown'));
        step(state, 'protect-tool-results', protectToolResults);
        step(state, 'protect-tool-requests', protectToolRequests);
        step(state, 'transform-mermaid-placeholders', dependency('transformMermaidPlaceholders'));
        step(state, 'protect-code-blocks', protectCodeBlocks);
        if (assistant) step(state, 'transform-flowlock-blocks', dependency('transformFlowlockBlocks'));
        step(state, 'deindent-misinterpreted-code-blocks', dependency('deIndentMisinterpretedCodeBlocks'));
        step(state, 'deindent-html', dependency('deIndentHtml'));
        step(state, 'deindent-tool-request-blocks', dependency('deIndentToolRequestBlocks'));
        step(state, 'transform-desktop-push', transformDesktopPush);
        step(state, 'restore-tool-requests', (text) => restoreMap(text, state.state.toolRequestMap));
        step(state, 'transform-special-blocks', (text) => dependency('transformSpecialBlocks')(text, state.state.codeBlockMap));
        step(state, 'ensure-html-fenced', dependency('ensureHtmlFenced'));
        step(state, 'apply-common-content-processors', dependency('applyContentProcessors'));
        step(state, 'normalize-adjacent-bold-boundaries', normalizeAdjacentBoldBoundaries);
        step(state, 'restore-code-blocks', (text) => restoreMap(text, state.state.codeBlockMap));
        return { text: state.text, meta: state.meta, state: state.state };
    }

    function runStreamFastPipeline(input, options = {}) {
        const state = context(input, options, PIPELINE_MODES.STREAM_FAST);
        step(state, 'strip-persona-backfill', stripPersonaBackfill);
        step(state, 'normalize-emoticon-urls', dependency('fixEmoticonUrlsInMarkdown'));
        step(state, 'deindent-misinterpreted-code-blocks', dependency('deIndentMisinterpretedCodeBlocks'));
        step(state, 'apply-common-content-processors', dependency('applyContentProcessors'));
        step(state, 'normalize-adjacent-bold-boundaries', normalizeAdjacentBoldBoundaries);
        return { text: state.text, meta: state.meta, state: state.state };
    }

    return {
        process(input, options = {}) {
            return options.mode === PIPELINE_MODES.STREAM_FAST
                ? runStreamFastPipeline(input, options) : runFullRenderPipeline(input, options);
        },
        runFullRenderPipeline,
        runStreamFastPipeline,
    };
}

export { PIPELINE_MODES, createAgentContentPipeline };
