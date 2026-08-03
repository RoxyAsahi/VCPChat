function createAgentRendererHtmlCache({
    version,
    maxBytes = 20 * 1024 * 1024,
    maxEntries = 500,
    maxSingleBytes = 1024 * 1024,
    minTextLength = 512,
    maxTextLength = 512 * 1024,
    getSettings,
    containsScopedHtml,
    renderUncached,
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
        version,
        options.messageRole || 'assistant',
        options.depth ?? 0,
        settingsFingerprint(options.settings || getSettings()),
        text.length,
        hash(text),
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

export { createAgentRendererHtmlCache };
