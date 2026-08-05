function escapeHtml(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function isLiteralMarkerMention(source, index, marker) {
    const previous = index > 0 ? source[index - 1] : '';
    const next = source[index + marker.length] || '';
    return ['[', '(', '`', '"', "'", '\u201c', '\u2018'].includes(previous)
        || [']', ')', '`', '"', "'", '\u201d', '\u2019'].includes(next);
}

function processStartEndMarkers(value) {
    if (typeof value !== 'string' || !/[{\u300c](?:\u59cb|\u672b)/.test(value)) return value;
    const escapeStarts = /([\u300c{]\u59cb[Ee][Ss][Cc][Aa][Pp][Ee][\u300d}])/gi;
    const escapeEnds = /([\u300c{]\u672b[Ee][Ss][Cc][Aa][Pp][Ee][\u300d}])/gi;
    const blocks = [];
    let text = value;
    let cursor = 0;
    while (true) {
        escapeStarts.lastIndex = cursor;
        const start = escapeStarts.exec(text);
        if (!start) break;
        if (isLiteralMarkerMention(text, start.index, start[0])) {
            cursor = start.index + start[0].length;
            continue;
        }
        const contentStart = start.index + start[0].length;
        escapeEnds.lastIndex = contentStart;
        const end = escapeEnds.exec(text);
        const endIndex = end ? end.index : text.length;
        const endMarker = end?.[0] || '';
        const placeholder = `___VCP_AGENT_ESCAPE_${blocks.length}___`;
        blocks.push({ placeholder, start: start[0], end: endMarker, content: text.slice(contentStart, endIndex) });
        text = text.slice(0, start.index) + placeholder + text.slice(endIndex + endMarker.length);
        cursor = start.index + placeholder.length;
    }

    const normalStarts = /([\u300c{]\u59cb[\u300d}])/g;
    const normalEnds = /([\u300c{]\u672b[\u300d}])/g;
    cursor = 0;
    while (cursor < text.length) {
        normalStarts.lastIndex = cursor;
        const start = normalStarts.exec(text);
        if (!start) break;
        if (isLiteralMarkerMention(text, start.index, start[0])) {
            cursor = start.index + start[0].length;
            continue;
        }
        const contentStart = start.index + start[0].length;
        normalEnds.lastIndex = contentStart;
        const end = normalEnds.exec(text);
        if (!end) {
            text = text.slice(0, start.index) + start[0] + escapeHtml(text.slice(contentStart));
            break;
        }
        const replacement = start[0] + escapeHtml(text.slice(contentStart, end.index)) + end[0];
        text = text.slice(0, start.index) + replacement + text.slice(end.index + end[0].length);
        cursor = start.index + replacement.length;
    }
    for (const block of blocks) {
        text = text.split(block.placeholder).join(block.start + escapeHtml(block.content) + block.end);
    }
    return text;
}

function deIndentToolRequestBlocks(value) {
    if (typeof value !== 'string') return value;
    let inside = false;
    return value.split('\n').map((line) => {
        const quoted = /`[^`]*<<<\[(?:END_)?TOOL_REQUEST\]>>>[^`]*`/.test(line);
        const starts = !quoted && line.includes('<<<[TOOL_REQUEST]>>>');
        const ends = !quoted && line.includes('<<<[END_TOOL_REQUEST]>>>');
        const result = starts || inside ? line.trimStart() : line;
        if (starts) inside = true;
        if (ends) inside = false;
        return result;
    }).join('\n');
}

function deIndentMisinterpretedCodeBlocks(value) {
    if (typeof value !== 'string') return value;
    let fenced = false;
    return value.split('\n').map((line) => {
        if (line.trim().startsWith('```')) {
            fenced = !fenced;
            return line.trimStart();
        }
        if (fenced || /^\s*([-*]|\d+\.)\s+/.test(line)) return line;
        const trimmed = line.trimStart();
        if (trimmed === line) return line;
        const html = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>/])/.test(trimmed) || /^<!--/.test(trimmed);
        const cjk = /^[\u4e00-\u9fff]/.test(trimmed);
        return html || cjk ? trimmed : line;
    }).join('\n');
}

function applyContentProcessors(value) {
    if (typeof value !== 'string') return value;
    let fenced = false;
    const normalized = value.split('\n').map((line) => {
        if (line.trim().startsWith('```')) {
            fenced = !fenced;
            return line.trimStart();
        }
        return line;
    }).join('\n');
    return normalized.replace(/^(\s*```)(?![\r\n])/gm, '$1\n')
        .replace(/(^|[^/\\=~])~(?![\s~=/])/g, '$1~ ')
        .replace(/^(\[(?:(?!\]:\s).)*\u7684\u53d1\u8a00\]:\s*)+/g, '')
        .replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Agent-Separator -->\n\n$2');
}

function scopeSelector(selector, scopeId) {
    if (/^(@|from|to|\d+%)/.test(selector)) return selector;
    if (/^(:root|html|body)$/i.test(selector)) return `#${scopeId}`;
    if (/^(html|body)\s+/i.test(selector)) return selector.replace(/^(html|body)\s+/i, `#${scopeId} `);
    if (/^:root\s+/.test(selector)) return selector.replace(/^:root\s+/, `#${scopeId} `);
    if (/^::?[\w-]+$/.test(selector)) return `#${scopeId}${selector}`;
    return selector === '*' ? `#${scopeId} *` : `#${scopeId} ${selector}`;
}

function scopeCss(value, scopeId) {
    const css = String(value || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let depth = 0;
    let current = '';
    for (const character of css) {
        current += character;
        if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
            rules.push(current.trim());
            current = '';
        }
    }
    if (current.trim()) rules.push(current.trim());
    return rules.map((rule) => {
        const match = rule.match(/^([^{]+)\{([\s\S]*)\}$/);
        if (!match || match[1].trim().startsWith('@')) return rule;
        const selectors = match[1].split(',').map((selector) => scopeSelector(selector.trim(), scopeId)).join(', ');
        return `${selectors} { ${match[2]} }`;
    }).join('\n');
}

const TAG_REGEX = /@([\u4e00-\u9fffA-Za-z0-9_]+)/g;
const ALERT_TAG_REGEX = /@!([\u4e00-\u9fffA-Za-z0-9_]+)/g;
const QUOTE_REGEX = /(?:"([^"]*)"|\u201c([^\u201d]*)\u201d)/g;

function highlightAllPatternsInMessage(root) {
    const documentRef = root?.ownerDocument;
    const nodeFilter = documentRef?.defaultView?.NodeFilter || globalThis.NodeFilter;
    if (!root || !documentRef || !nodeFilter) return;
    const walker = documentRef.createTreeWalker(root, nodeFilter.SHOW_TEXT, (node) => {
        if (node.parentElement?.closest('pre, code, style, script, textarea, .highlighted-tag, .highlighted-alert-tag, .highlighted-quote')) {
            return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
    });
    const pending = [];
    let node;
    while ((node = walker.nextNode())) {
        const matches = [];
        for (const [type, pattern] of [['tag', TAG_REGEX], ['alert-tag', ALERT_TAG_REGEX], ['quote', QUOTE_REGEX]]) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(node.nodeValue || '')) !== null) {
                if (type !== 'quote' || match[1] || match[2]) matches.push({ type, index: match.index, text: match[0] });
            }
        }
        matches.sort((left, right) => left.index - right.index);
        const filtered = [];
        let end = -1;
        for (const match of matches) {
            if (match.index >= end) { filtered.push(match); end = match.index + match.text.length; }
        }
        if (filtered.length) pending.push({ node, matches: filtered });
    }
    for (const entry of pending.reverse()) {
        if (!entry.node.parentNode) continue;
        const fragment = documentRef.createDocumentFragment();
        let cursor = 0;
        for (const match of entry.matches) {
            if (match.index > cursor) fragment.append(documentRef.createTextNode(entry.node.nodeValue.slice(cursor, match.index)));
            const span = documentRef.createElement('span');
            span.className = `highlighted-${match.type}`;
            span.textContent = match.text;
            fragment.append(span);
            cursor = match.index + match.text.length;
        }
        if (cursor < entry.node.nodeValue.length) fragment.append(documentRef.createTextNode(entry.node.nodeValue.slice(cursor)));
        entry.node.parentNode.replaceChild(fragment, entry.node);
    }
}

function looksLikeSafeSingleDollarMath(content) {
    const value = String(content || '').trim();
    if (!value) return false;
    const signal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(value);
    return signal || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        || /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|\u2030|\u00b0))?$/.test(value);
}

function normalizeSafeSingleDollarMath(root) {
    const documentRef = root?.ownerDocument;
    const nodeFilter = documentRef?.defaultView?.NodeFilter || globalThis.NodeFilter;
    if (!documentRef || !nodeFilter) return;
    const walker = documentRef.createTreeWalker(root, nodeFilter.SHOW_TEXT, (node) => (
        node.parentElement?.closest('pre, code, script, style, textarea, .katex') || !node.nodeValue?.includes('$')
            ? nodeFilter.FILTER_REJECT : nodeFilter.FILTER_ACCEPT
    ));
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
        textNode.nodeValue = textNode.nodeValue.replace(/(^|[^\w\\$])\$([^$\n]{1,1200}?)\$(?![\w])/g,
            (match, prefix, content) => looksLikeSafeSingleDollarMath(content) ? `${prefix}\\(${content.trim()}\\)` : match);
    }
}

async function copyText(documentRef, value) {
    const navigatorRef = documentRef.defaultView?.navigator;
    if (navigatorRef?.clipboard?.writeText) return navigatorRef.clipboard.writeText(value);
    const textarea = documentRef.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.className = 'vcp-ui-scope agent-chat-clipboard-proxy';
    documentRef.body.append(textarea);
    textarea.select();
    try { documentRef.execCommand?.('copy'); } finally { textarea.remove(); }
}

function setupCodeCopyButtons(root) {
    const documentRef = root?.ownerDocument;
    if (!documentRef) return;
    for (const pre of root.querySelectorAll('pre')) {
        if (pre.dataset.vcpCodeCopy === 'true' || pre.closest('.vcp-tool-use-bubble, .vcp-tool-result-bubble')) continue;
        const code = pre.querySelector('code');
        const value = pre.dataset.rawContent || code?.textContent || pre.textContent || '';
        if (value.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length <= 4) continue;
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'vcp-code-copy-button';
        button.dataset.vcpInteractive = 'true';
        button.title = '\u590d\u5236\u4ee3\u7801';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<span class="vcp-ui-icon" data-vcp-icon="content_copy">content_copy</span>';
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            try {
                await copyText(documentRef, value);
                button.classList.add('copied');
            } catch {
                button.classList.add('failed');
            } finally {
                button.disabled = false;
            }
        });
        pre.classList.add('vcp-codeblock-with-copy');
        pre.append(button);
        pre.dataset.vcpCodeCopy = 'true';
    }
}

function processRenderedContent(root) {
    if (!root) return;
    normalizeSafeSingleDollarMath(root);
    const windowRef = root.ownerDocument?.defaultView || globalThis.window;
    windowRef?.renderMathInElement?.(root, {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false,
    });
    setupCodeCopyButtons(root);
    if (windowRef?.hljs) {
        for (const block of root.querySelectorAll('pre code')) {
            if (block.parentElement && !block.parentElement.dataset.vcpPrettified) windowRef.hljs.highlightElement(block);
        }
    }
}

function cleanupPreviewsInContent(root) {
    if (!root) return;
    for (const container of root.querySelectorAll('.vcp-html-preview-container')) {
        try { container._vcpCleanup?.(); } catch (error) { console.warn('[AgentRenderer] Preview cleanup failed:', error); }
        delete container._vcpCleanup;
    }
}

export {
    applyContentProcessors,
    cleanupPreviewsInContent,
    deIndentMisinterpretedCodeBlocks,
    deIndentToolRequestBlocks,
    escapeHtml,
    highlightAllPatternsInMessage,
    processRenderedContent,
    processStartEndMarkers,
    scopeCss,
};
