let library = [];
let initialized = false;
let initialization = null;

function editDistance(left, right) {
    const a = String(left || '').toLowerCase();
    const b = String(right || '').toLowerCase();
    const costs = [];
    for (let row = 0; row <= a.length; row += 1) {
        let previous = row;
        for (let column = 0; column <= b.length; column += 1) {
            if (row === 0) costs[column] = column;
            else if (column > 0) {
                let value = costs[column - 1];
                if (a[row - 1] !== b[column - 1]) value = Math.min(value, previous, costs[column]) + 1;
                costs[column - 1] = previous;
                previous = value;
            }
        }
        if (row > 0) costs[b.length] = previous;
    }
    return costs[b.length] || 0;
}

function similarity(left, right) {
    const longer = String(left || '').length >= String(right || '').length ? String(left || '') : String(right || '');
    const shorter = longer === String(left || '') ? String(right || '') : String(left || '');
    return longer.length ? (longer.length - editDistance(longer, shorter)) / longer.length : 1;
}

function pathInfo(value) {
    if (!value) return { filename: null, packageName: null };
    let decoded = String(value);
    try { decoded = decodeURIComponent(new URL(decoded, 'file:///').pathname); } catch {
        try { decoded = decodeURIComponent(decoded); } catch {}
    }
    const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
    return { filename: parts.at(-1) || null, packageName: parts.at(-2) || null };
}

function initialize(electronAPI = {}) {
    if (initialization) return initialization;
    initialization = Promise.resolve().then(async () => {
        try {
            const result = typeof electronAPI.getEmoticonLibrary === 'function'
                ? await electronAPI.getEmoticonLibrary() : [];
            library = Array.isArray(result) ? result.filter((item) => item?.url) : [];
        } catch (error) {
            library = [];
            console.warn('[AgentRenderer] Emoticon catalog unavailable:', error.message || error);
        } finally {
            initialized = true;
        }
    });
    return initialization;
}

function fixEmoticonUrl(originalSource) {
    if (!initialized || !library.length || !originalSource) return originalSource;
    let decoded;
    try { decoded = decodeURIComponent(originalSource); } catch { return originalSource; }
    if (!decoded.includes('\u8868\u60c5\u5305')) return originalSource;
    if (library.some((item) => {
        try { return decodeURIComponent(item.url) === decoded; } catch { return item.url === originalSource; }
    })) return originalSource;
    const target = pathInfo(originalSource);
    if (!target.filename) return originalSource;
    let best = null;
    let score = -1;
    for (const item of library) {
        const candidate = pathInfo(item.url);
        const packageScore = target.packageName && candidate.packageName
            ? similarity(target.packageName, candidate.packageName)
            : target.packageName === candidate.packageName ? 1 : 0;
        const filenameScore = similarity(target.filename, item.filename || candidate.filename || '');
        const candidateScore = (packageScore * 0.7) + (filenameScore * 0.3);
        if (candidateScore > score) { score = candidateScore; best = item; }
    }
    return best && score > 0.6 ? best.url : originalSource;
}

function resetForTests() {
    library = [];
    initialized = false;
    initialization = null;
}

export { fixEmoticonUrl, initialize, resetForTests };
