// Clean-room implementation informed by OpenCode's markdown-stream contract
// (MIT, revision a45c2b917e). This module is Renderer-only: it never observes
// Session, Thread, Tool, approval, transport, or persistent state.

function languageOf(info) {
    return String(info || '').trim().split(/\s+/, 1)[0] || undefined;
}

function containsReferenceDefinition(text) {
    return text.includes(']:') && /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text);
}

function liveSource(raw) {
    // Live content is inserted as text, not HTML. Keeping incomplete links and
    // emphasis literal is preferable to presenting a malformed interactive link.
    return raw;
}

function codeSource(raw) {
    const firstNewline = raw.indexOf('\n');
    if (firstNewline < 0) return '';
    const body = raw.slice(firstNewline + 1);
    const lines = body.split('\n');
    if (/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(lines.at(-1) || '')) lines.pop();
    return lines.join('\n');
}

function appendProse(blocks, raw, final) {
    if (!raw) return;
    const separator = /[\s\S]*?\r?\n[ \t]*\r?\n/g;
    let offset = 0;
    let match;
    while ((match = separator.exec(raw))) {
        const part = match[0];
        if (part) blocks.push({ raw: part, src: part, mode: 'full' });
        offset = match.index + part.length;
    }
    const tail = raw.slice(offset);
    if (tail || blocks.length === 0) blocks.push({ raw: tail, src: final ? liveSource(tail) : tail, mode: final ? 'live' : 'full' });
}

function fenceAt(text, from) {
    const start = new RegExp('^[ \\t]{0,3}(`{3,}|~{3,})([^\\n]*)\\r?\\n?', 'gm');
    start.lastIndex = from;
    const open = start.exec(text);
    if (!open) return null;
    const marker = open[1];
    const escaped = marker[0] === '`' ? '`' : '~';
    const close = new RegExp(`^[ \\t]{0,3}${escaped}{${marker.length},}[ \\t]*$`, 'gm');
    close.lastIndex = start.lastIndex;
    const closing = close.exec(text);
    return {
        start: open.index,
        bodyStart: start.lastIndex,
        end: closing ? close.lastIndex : text.length,
        raw: text.slice(open.index, closing ? close.lastIndex : text.length),
        language: languageOf(open[2]),
        complete: Boolean(closing),
    };
}

function streamMarkdown(text, streaming) {
    const source = String(text || '');
    if (!streaming) return [{ key: 'markdown:0', raw: source, src: source, mode: 'full', complete: true }];
    if (containsReferenceDefinition(source)) return [{ key: 'markdown:0', raw: source, src: liveSource(source), mode: 'live' }];

    const blocks = [];
    let cursor = 0;
    while (cursor < source.length) {
        const fence = fenceAt(source, cursor);
        if (!fence) {
            appendProse(blocks, source.slice(cursor), true);
            break;
        }
        appendProse(blocks, source.slice(cursor, fence.start), false);
        blocks.push({
            raw: fence.raw,
            src: codeSource(fence.raw),
            mode: 'code',
            language: fence.language,
            complete: fence.complete || undefined,
        });
        cursor = fence.end;
        if (!fence.complete) break;
    }
    if (source === '') blocks.push({ raw: '', src: '', mode: 'live' });
    return blocks.map((block, index) => ({ ...block, key: `markdown:${index}` }));
}

function canReusePendingMarkdownBlock(current, next) {
    if (!current || current.mode !== next.mode) return false;
    if (next.mode === 'code') return next.raw.startsWith(current.raw);
    return current.raw === next.raw;
}

function projectMarkdownStream(previous, text, streaming) {
    const source = String(text || '');
    if (!streaming || !previous || !source.startsWith(previous.text)) {
        return { text: source, blocks: streamMarkdown(source, streaming) };
    }
    const tail = previous.blocks.at(-1);
    const suffix = source.slice(previous.text.length);
    if (!suffix || tail?.mode !== 'code' || tail.complete) {
        return { text: source, blocks: streamMarkdown(source, streaming) };
    }
    const combined = `${tail.raw}${suffix}`;
    const reparsed = streamMarkdown(combined, true);
    if (reparsed.length !== 1 || reparsed[0].mode !== 'code') {
        return { text: source, blocks: streamMarkdown(source, streaming) };
    }
    return {
        text: source,
        blocks: [...previous.blocks.slice(0, -1), { ...reparsed[0], key: tail.key }],
    };
}

export { canReusePendingMarkdownBlock, projectMarkdownStream, streamMarkdown };
