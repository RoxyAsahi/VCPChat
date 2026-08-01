// Agent-only fork of the presentation responsibilities in messageRenderer.js.
// It deliberately excludes chat history refs, persistence, streamManager,
// current topic selection and the main-chat context-menu state machine.

import {
    highlightAllPatternsInMessage,
    processRenderedContent,
} from '../../renderer/contentProcessor.js';

const MERMAID_FENCE_RE = /```(?:mermaid|flowchart|graph)[^\S\n]*\n([\s\S]*?)```/gi;
const THINK_RE = /^[ \t]*<think(?:ing)?>[ \t]*(?:\r?\n|$)([\s\S]*?)^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function stripActiveContent(html) {
    return String(html || '')
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style\s*>/gi, '');
}

function createMarkedParser(markedApi) {
    if (markedApi && typeof markedApi.Marked === 'function') {
        return new markedApi.Marked({
            gfm: true,
            tables: true,
            breaks: true,
            pedantic: false,
            sanitize: false,
            smartLists: true,
            smartypants: false,
        });
    }
    if (markedApi && typeof markedApi.parse === 'function') return markedApi;
    return { parse: (text) => `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>` };
}

function protectPresentationBlocks(source, parseMarkdown) {
    const placeholders = [];
    let text = String(source || '').replace(MERMAID_FENCE_RE, (_, code) => {
        const index = placeholders.length;
        placeholders.push({ kind: 'mermaid', source: String(code || '').trim() });
        return `\nVCPAGENTBLOCK${index}X\n`;
    });
    text = text.replace(THINK_RE, (_, reasoning) => {
        const index = placeholders.length;
        placeholders.push({ kind: 'reasoning', source: String(reasoning || '').trim() });
        return `\nVCPAGENTBLOCK${index}X\n`;
    });
    let html = parseMarkdown(text);
    placeholders.forEach((block, index) => {
        const token = `VCPAGENTBLOCK${index}X`;
        const replacement = block.kind === 'mermaid'
            ? `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeURIComponent(block.source)}"></div>`
            : `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain"><div class="vcp-thought-chain-header"><span class="vcp-thought-chain-icon">lightbulb</span><span class="vcp-thought-chain-label">思维链</span><span class="vcp-result-toggle-icon"></span></div><div class="vcp-thought-chain-collapsible-content"><div class="vcp-thought-chain-body">${parseMarkdown(block.source)}</div></div></div>`;
        html = html.replace(new RegExp(`<p>\\s*${token}\\s*<\\/p>`, 'i'), replacement).replace(token, replacement);
    });
    return html;
}

async function renderMermaid(container, mermaidApi) {
    if (!mermaidApi) return;
    const placeholders = [...container.querySelectorAll('.mermaid-placeholder')];
    for (const element of placeholders) {
        try {
            element.textContent = decodeURIComponent(element.dataset.mermaidCode || '');
            element.classList.remove('mermaid-placeholder');
            element.classList.add('mermaid');
        } catch (error) {
            element.textContent = `Mermaid source decode failed: ${error.message}`;
            element.classList.add('mermaid-error');
        }
    }
    if (placeholders.length === 0) return;
    mermaidApi.initialize?.({ startOnLoad: false });
    try {
        await mermaidApi.run?.({ nodes: placeholders.filter((element) => element.classList.contains('mermaid')) });
    } catch (error) {
        for (const element of placeholders) {
            if (!element.querySelector('svg')) element.textContent = `Mermaid 渲染错误: ${error.message}`;
        }
    }
}

function bindSharedInteractions(container) {
    container.querySelectorAll('.vcp-thought-chain-header:not([data-agent-presentation-bound])').forEach((header) => {
        header.dataset.agentPresentationBound = 'true';
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        const toggle = () => {
            const bubble = header.closest('.vcp-thought-chain-bubble');
            bubble?.classList.toggle('expanded');
            header.setAttribute('aria-expanded', String(bubble?.classList.contains('expanded')));
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
        });
    });
    container.querySelectorAll('a[href]').forEach((link) => {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.addEventListener('click', (event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

            const rawHref = link.getAttribute('href') || '';
            const url = link.href;
            const isWindowsPath = /^(?:[a-z]:[\\/]|\\\\)/i.test(rawHref);
            if (!isWindowsPath && !/^(?:https?:|file:|magnet:)/i.test(url)) return;

            const desktopBridge = globalThis.window?.electronAPI || globalThis.window?.desktopAPI;
            if (typeof desktopBridge?.sendOpenExternalLink !== 'function') return;

            event.preventDefault();
            desktopBridge.sendOpenExternalLink(isWindowsPath ? rawHref : url);
        });
    });
}

function createAgentContentRendererFork(options = {}) {
    const globalWindow = options.window || globalThis.window;
    const parser = createMarkedParser(options.marked || globalWindow?.marked);
    const settings = options.settings || {};
    const parseMarkdown = (text) => parser.parse(String(text || ''));

    return {
        renderContent(text) {
            return stripActiveContent(protectPresentationBlocks(text, parseMarkdown));
        },
        renderReasoning(text) {
            const body = parseMarkdown(String(text || ''));
            return `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain"><div class="vcp-thought-chain-header"><span class="vcp-thought-chain-icon">lightbulb</span><span class="vcp-thought-chain-label">推理过程</span><span class="vcp-result-toggle-icon"></span></div><div class="vcp-thought-chain-collapsible-content"><div class="vcp-thought-chain-body">${body}</div></div></div>`;
        },
        async runPostRender(container) {
            if (!container?.isConnected && !options.allowDetachedPostRender) return;
            processRenderedContent(container, settings);
            await renderMermaid(container, options.mermaid || globalWindow?.mermaid);
            highlightAllPatternsInMessage(container);
            bindSharedInteractions(container);
        },
    };
}

export { createAgentContentRendererFork };
