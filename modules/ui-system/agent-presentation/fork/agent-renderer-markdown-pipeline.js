import { createContentPipeline, PIPELINE_MODES } from '../../../renderer/contentPipeline.js';
import { createAgentRendererHtmlCache } from './agent-renderer-html-cache.js';
import { protectLatexBlocks, restoreLatexBlocks } from './agent-renderer-latex.js';

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

export { createAgentRendererMarkdownPipeline };
