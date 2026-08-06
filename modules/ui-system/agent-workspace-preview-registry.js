import { node } from './agent-workbench-dom.js';

const EDITABLE_KINDS = new Set(['text', 'markdown', 'html']);

function sanitizeRenderedMarkup(document, html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    for (const blocked of template.content.querySelectorAll('script,iframe,object,embed,form,input,button,textarea,select,link,meta,base,style')) {
        blocked.remove();
    }
    for (const element of template.content.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || name === 'style') element.removeAttribute(attribute.name);
            if ((name === 'href' || name === 'src') && !/^(?:https?:|mailto:|data:image\/)/i.test(value)) {
                element.removeAttribute(attribute.name);
            }
        }
        if (element.tagName === 'A') {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    }
    return template.content;
}

function renderSource(preview, document) {
    const pre = node('pre', 'agent-workspace-preview-text agent-workspace-preview-source', undefined, document);
    const code = node('code', '', preview.content || '', document);
    const extension = String(preview.displayName || '').split('.').pop()?.toLowerCase();
    if (extension) code.className = `language-${extension}`;
    pre.append(code);
    const highlighter = document.defaultView?.hljs;
    if (highlighter?.highlightElement) queueMicrotask(() => {
        if (code.isConnected) highlighter.highlightElement(code);
    });
    return pre;
}

function renderMarkdown(preview, document) {
    const host = node('article', 'agent-workspace-preview-rendered markdown-body', undefined, document);
    const marked = document.defaultView?.marked;
    const html = typeof marked?.parse === 'function' ? marked.parse(preview.content || '') : preview.content || '';
    host.append(sanitizeRenderedMarkup(document, html));
    const highlighter = document.defaultView?.hljs;
    if (highlighter?.highlightElement) queueMicrotask(() => {
        for (const code of host.querySelectorAll('pre code')) highlighter.highlightElement(code);
    });
    return host;
}

function htmlDocument(content) {
    const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    const source = String(content || '');
    if (/<!doctype|<html[\s>]/i.test(source)) {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
        if (/<head[\s>]/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
        if (/<html[\s>]/i.test(source)) return source.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
        return `${meta}${source}`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}*{box-sizing:border-box}img{max-width:100%;height:auto}</style></head><body>${source}</body></html>`;
}

function renderHtml(preview, document) {
    const frame = document.createElement('iframe');
    frame.className = 'agent-workspace-preview-frame';
    frame.title = `${preview.displayName || 'HTML'} 沙箱预览`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = htmlDocument(preview.content);
    return frame;
}

function renderEditor(preview, browser, actions, document) {
    const wrap = node('div', 'agent-workspace-editor', undefined, document);
    const textarea = document.createElement('textarea');
    textarea.className = 'agent-workspace-editor-input';
    textarea.value = browser.editDraft;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', `编辑 ${preview.displayName || preview.relativePath}`);
    textarea.addEventListener('input', () => actions.syncDirty?.(actions.updateEditDraft?.(textarea.value)));
    textarea.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
        event.preventDefault();
        actions.run?.(() => actions.saveText?.());
    });
    wrap.append(textarea);
    const CodeMirror = document.defaultView?.CodeMirror;
    if (typeof CodeMirror?.fromTextArea === 'function') queueMicrotask(() => {
        if (!textarea.isConnected) return;
        const editor = CodeMirror.fromTextArea(textarea, {
            lineNumbers: true,
            lineWrapping: false,
            mode: String(preview.displayName || '').split('.').pop()?.toLowerCase() || null,
            theme: document.documentElement?.classList.contains('dark-theme') ? 'material-darker' : 'default',
        });
        editor.on('change', () => actions.syncDirty?.(actions.updateEditDraft?.(editor.getValue())));
        editor.setSize('100%', '100%');
    });
    return wrap;
}

function renderPdf(preview, document) {
    if (!preview.dataUrl) return node('div', 'agent-workspace-preview-note', 'PDF 文件过大，请使用系统程序打开。', document);
    const frame = document.createElement('iframe');
    frame.className = 'agent-workspace-preview-frame agent-workspace-preview-pdf';
    frame.title = preview.displayName || 'PDF 预览';
    frame.src = preview.dataUrl;
    return frame;
}

function getWorkspacePreviewModes(preview) {
    if (!preview) return [];
    if (preview.kind === 'markdown' || preview.kind === 'html') {
        return preview.editable ? ['preview', 'source', 'edit'] : ['preview', 'source'];
    }
    if (preview.kind === 'text') return preview.editable ? ['source', 'edit'] : ['source'];
    return ['preview'];
}

function renderWorkspacePreviewContent({ preview, browser, actions, document = globalThis.document }) {
    if (browser.previewMode === 'edit' && EDITABLE_KINDS.has(preview.kind) && preview.editable) {
        return renderEditor(preview, browser, actions, document);
    }
    if (browser.previewMode === 'source' && EDITABLE_KINDS.has(preview.kind)) return renderSource(preview, document);
    if (preview.kind === 'markdown') return renderMarkdown(preview, document);
    if (preview.kind === 'html') return renderHtml(preview, document);
    if (preview.kind === 'text') return renderSource(preview, document);
    if (preview.kind === 'image' && preview.dataUrl) {
        const image = document.createElement('img');
        image.className = 'agent-workspace-preview-image';
        image.src = preview.dataUrl;
        image.alt = preview.displayName;
        return image;
    }
    if (preview.kind === 'pdf') return renderPdf(preview, document);
    return node('div', 'agent-workspace-preview-note', `${preview.kind} · ${preview.mimeType || '未知类型'} · ${preview.byteLen} bytes`, document);
}

export { getWorkspacePreviewModes, renderWorkspacePreviewContent, sanitizeRenderedMarkup };
