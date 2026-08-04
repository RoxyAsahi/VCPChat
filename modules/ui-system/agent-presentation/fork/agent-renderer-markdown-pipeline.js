import { createContentPipeline, PIPELINE_MODES } from '../../../renderer/contentPipeline.js';
import { protectLatexBlocks, restoreLatexBlocks } from './agent-renderer-latex.js';

function createAgentRendererHtmlCache({
    version, maxBytes = 20 * 1024 * 1024, maxEntries = 500, maxSingleBytes = 1024 * 1024,
    minTextLength = 512, maxTextLength = 512 * 1024, getSettings, containsScopedHtml, renderUncached,
}) {
    const entries = new Map();
    const stats = { hits: 0, misses: 0, skips: 0, evictions: 0 };
    let bytes = 0;
    const estimateBytes = (text) => typeof text === 'string' ? text.length * 2 : 0;
    const hash = (text) => {
        let value = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 0x01000193);
        }
        return (value >>> 0).toString(16);
    };
    const settingsFingerprint = (settings = {}) => JSON.stringify({
        enableAiMessageButtons: settings.enableAiMessageButtons !== false,
    });
    const bypass = (text, options = {}) => {
        if (typeof text !== 'string' || !text) return true;
        if (text.length < minTextLength || text.length > maxTextLength) return true;
        return (options.messageRole || 'assistant') === 'assistant' && containsScopedHtml(text);
    };
    const keyFor = (text, options = {}) => [
        version, options.messageRole || 'assistant', options.depth ?? 0,
        settingsFingerprint(options.settings || getSettings()), text.length, hash(text),
    ].join('|');
    const trim = () => {
        while (bytes > maxBytes || entries.size > maxEntries) {
            const oldestKey = entries.keys().next().value;
            if (oldestKey === undefined) break;
            bytes -= entries.get(oldestKey)?.size || 0;
            entries.delete(oldestKey);
            stats.evictions += 1;
        }
    };
    const clear = () => { entries.clear(); bytes = 0; };
    const render = (text, options = {}) => {
        if (bypass(text, options)) {
            stats.skips += 1;
            return renderUncached(text, options);
        }
        const key = keyFor(text, options);
        const cached = entries.get(key);
        if (cached) {
            entries.delete(key);
            cached.lastUsed = Date.now();
            cached.hits += 1;
            entries.set(key, cached);
            stats.hits += 1;
            return cached.html;
        }
        stats.misses += 1;
        const html = renderUncached(text, options);
        const size = estimateBytes(html);
        if (size > 0 && size <= maxSingleBytes) {
            if (entries.has(key)) bytes -= entries.get(key)?.size || 0;
            entries.set(key, { html, size, hits: 0, lastUsed: Date.now() });
            bytes += size;
            trim();
        }
        return html;
    };
    return { clear, render, stats, get size() { return entries.size; } };
}

function createAgentRendererMarkdownPipeline(options) {
    let pipeline = null;

    function fixEmoticonUrls(text) {
        if (typeof text !== 'string' || !text) return text;
        const fix = options.fixEmoticonUrl;
        return text
            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => `![${alt}](${fix(url)})`)
            .replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi,
                (match, before, url, after) => `<img${before}src="${fix(url)}"${after}>`);
    }

    function initialize() {
        pipeline = createContentPipeline({
            escapeHtml: options.escapeHtml,
            processStartEndMarkers: options.processStartEndMarkers,
            fixEmoticonUrlsInMarkdown: fixEmoticonUrls,
            deIndentMisinterpretedCodeBlocks: options.deIndentMisinterpretedCodeBlocks,
            deIndentHtml: options.deIndentHtml,
            deIndentToolRequestBlocks: options.deIndentToolRequestBlocks,
            applyContentProcessors: options.applyContentProcessors,
            transformSpecialBlocks: options.transformSpecialBlocks,
            ensureHtmlFenced: options.ensureHtmlFenced,
            transformFlowlockBlocks: options.transformFlowlockBlocks,
            transformMermaidPlaceholders: options.transformMermaidPlaceholders,
            getToolResultRegex: options.getToolResultRegex,
            getToolRequestRegex: options.getToolRequestRegex,
            replaceToolRequestBlocks: options.replaceToolRequestBlocks,
            getCodeFenceRegex: options.getCodeFenceRegex,
            getDesktopPushRegex: options.getDesktopPushRegex,
            getDesktopPushPartialRegex: options.getDesktopPushPartialRegex,
        });
    }

    function renderUncached(text, renderOptions = {}) {
        const marked = options.getMarked();
        if (!marked) return options.escapeHtml(text);
        const settings = renderOptions.settings || options.getSettings();
        const messageRole = renderOptions.messageRole || 'assistant';
        const depth = renderOptions.depth || 0;
        const processed = pipeline
            ? pipeline.process(text, { mode: PIPELINE_MODES.FULL_RENDER, settings, messageRole, depth })
            : { text, state: {} };
        const { text: protectedText, map } = protectLatexBlocks(processed.text);
        let html = marked.parse(protectedText);
        html = restoreLatexBlocks(html, map);
        return options.restoreToolResults(html, processed.state.toolResultMap || null);
    }

    const cache = createAgentRendererHtmlCache({
        version: options.version,
        getSettings: options.getSettings,
        containsScopedHtml: options.containsScopedHtml,
        renderUncached,
    });

    return {
        initialize,
        render: (text, renderOptions = {}) => cache.render(text, renderOptions),
        clear: () => cache.clear(),
    };
}

function createAgentRendererScopedHtml({
    document, scopeCss, styleRegex, htmlTriggerRegex, htmlStyleTagRegex, htmlFenceCheckRegex,
    toolResultRegex, replaceToolRequestBlocks, desktopPushRegex, desktopPushPartialRegex, codeFenceRegex,
}) {
    function generateUniqueId() {
        return `vcp-bubble-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    }
    function containsScopedHtml(text) { return typeof text === 'string' && htmlTriggerRegex.test(text); }
    function containsStyle(text) { return typeof text === 'string' && htmlStyleTagRegex.test(text); }
    function injectStyles(content, scopeId) {
        let css = '';
        const processedContent = content.replace(styleRegex, (_match, value) => {
            css += `${value.trim()}\n`;
            return '';
        });
        if (css) {
            try {
                const style = document.createElement('style');
                style.type = 'text/css';
                style.dataset.vcpScopeId = scopeId;
                style.textContent = scopeCss(css, scopeId);
                document.head.append(style);
            } catch (error) {
                console.error(`[ScopedCSS] Failed to scope or inject CSS for ID: ${scopeId}`, error);
            }
        }
        return processedContent;
    }
    function process(content, scopeId, messageItem = null) {
        if (!scopeId || !containsScopedHtml(content)) return content;
        if (messageItem) {
            messageItem.dataset.vcpHtmlScopeCandidate = 'true';
            if (!containsStyle(content)) messageItem.dataset.vcpInlineHtmlScoped = 'true';
        }
        const blocks = [];
        const protect = (match) => {
            const placeholder = `__VCP_STYLE_PROTECT_${blocks.length}__`;
            blocks.push(match);
            return placeholder;
        };
        toolResultRegex.lastIndex = 0;
        let protectedText = content.replace(toolResultRegex, protect);
        toolResultRegex.lastIndex = 0;
        protectedText = replaceToolRequestBlocks(protectedText, protect);
        protectedText = protectedText.replace(desktopPushRegex, protect);
        protectedText = protectedText.replace(desktopPushPartialRegex, protect);
        protectedText = protectedText.replace(codeFenceRegex, protect);
        let restored = injectStyles(protectedText, scopeId);
        blocks.forEach((block, index) => {
            restored = restored.split(`__VCP_STYLE_PROTECT_${index}__`).join(block);
        });
        return restored;
    }
    function ensureHtmlFenced(text) {
        const startTag = '<!doctype html>';
        const endTag = '</html>';
        if (htmlFenceCheckRegex.test(text) || !text.toLowerCase().includes(startTag)) return text;
        const protectedRanges = [];
        replaceToolRequestBlocks(text, (match, _content, start, end) => {
            protectedRanges.push({ start, end });
            return match;
        });
        const isProtected = (index) => protectedRanges.some((range) => index >= range.start && index < range.end);
        let result = '';
        let cursor = 0;
        while (true) {
            const start = text.toLowerCase().indexOf(startTag, cursor);
            result += text.substring(cursor, start === -1 ? text.length : start);
            if (start === -1) break;
            const end = text.toLowerCase().indexOf(endTag, start + startTag.length);
            if (end === -1) { result += text.substring(start); break; }
            const block = text.substring(start, end + endTag.length);
            result += isProtected(start) || (result.match(/```/g) || []).length % 2 !== 0
                ? block : `\n\`\`\`html\n${block}\n\`\`\`\n`;
            cursor = end + endTag.length;
        }
        return result;
    }
    function deIndentHtml(text) {
        let inFence = false;
        return text.split('\n').map((line) => {
            if (line.trim().startsWith('```')) { inFence = !inFence; return line; }
            if (!inFence && !line.includes('<img') && /^\s+<(!|[a-zA-Z])/.test(line)) return line.trimStart();
            return line;
        }).join('\n');
    }
    return { generateUniqueId, containsScopedHtml, process, ensureHtmlFenced, deIndentHtml };
}

function compiledRegex(windowRef, rule) {
    if (!rule?.findPattern) return null;
    if (windowRef.uiHelperFunctions?.getCompiledRegex) {
        return windowRef.uiHelperFunctions.getCompiledRegex(rule.findPattern)?.regex || null;
    }
    if (windowRef.uiHelperFunctions?.regexFromString) {
        return windowRef.uiHelperFunctions.regexFromString(rule.findPattern);
    }
    const match = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
    return match ? new RegExp(match[1], match[2]) : new RegExp(rule.findPattern, 'g');
}

function createAgentRendererTextTransforms({ window, escapeHtml, transformButton, transformCanvas }) {
    function applyRegexRule(text, rule) {
        if (!rule?.findPattern || typeof text !== 'string') return text;
        try {
            const regex = compiledRegex(window, rule);
            if (!regex) return text;
            regex.lastIndex = 0;
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错:', rule.findPattern, error);
            return text;
        }
    }
    function applyFrontendRegexRules(text, rules, role, depth) {
        if (!Array.isArray(rules) || typeof text !== 'string') return text;
        return rules.filter((rule) => rule && rule.enabled !== false && rule.findPattern
            && rule.applyToFrontend && rule.applyToRoles?.includes(role)
            && (rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth)
            && (rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth))
            .reduce((value, rule) => applyRegexRule(value, rule), text);
    }
    function buildTurnDepthMap(history = []) {
        const turns = [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
            if (history[index].role === 'assistant') {
                const turn = { assistant: history[index], user: null };
                if (index > 0 && history[index - 1].role === 'user') turn.user = history[--index];
                turns.push(turn);
            } else if (history[index].role === 'user') turns.push({ assistant: null, user: history[index] });
        }
        turns.reverse();
        const depths = new Map();
        turns.forEach((turn, index) => {
            const depth = turns.length - 1 - index;
            if (turn.assistant?.id) depths.set(turn.assistant.id, depth);
            if (turn.user?.id) depths.set(turn.user.id, depth);
        });
        return depths;
    }
    function calculateDepthByTurns(messageId, history) { return buildTurnDepthMap(history).get(messageId) ?? 0; }
    function prepareUserMessageText(text) {
        const images = [];
        let processed = String(text || '').replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match) => {
            if (/on\w+\s*=/i.test(match) || /src\s*=\s*["']\s*javascript:/i.test(match)) return match;
            const placeholder = `__VCP_USER_IMG_${images.length}__`;
            images.push(match);
            return placeholder;
        });
        processed = escapeHtml(processed);
        images.forEach((image, index) => { processed = processed.replace(`__VCP_USER_IMG_${index}__`, image); });
        return transformCanvas(transformButton(processed));
    }
    return { applyFrontendRegexRules, buildTurnDepthMap, calculateDepthByTurns, prepareUserMessageText };
}

export {
    createAgentRendererHtmlCache,
    createAgentRendererMarkdownPipeline,
    createAgentRendererScopedHtml,
    createAgentRendererTextTransforms,
};
