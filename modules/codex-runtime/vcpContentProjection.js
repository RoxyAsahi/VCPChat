'use strict';

// Clean-room VCP marker projection. Reference contract: vcp-code-2.0
// `vcp-content.ts` at d7ce532451f2ebdf481c16b5cfff9967b63b6cf7.
// This is display-only: only Codex dynamicToolCall -> vcp_invoke may execute.

const MARKERS = Object.freeze({
    fold: ['<<<[VCP_DYNAMIC_FOLD]>>>', '<<<[END_VCP_DYNAMIC_FOLD]>>>'],
    info: ['<<<[VCPINFO]>>>', '<<<[END_VCPINFO]>>>'],
    toolRequest: ['<<<[TOOL_REQUEST]>>>', '<<<[END_TOOL_REQUEST]>>>'],
});
const MAX_MARKERS = 24;
const MAX_DETAIL = 16_384;
const MAX_SUMMARY = 2_000;

function boundedText(value, max = MAX_DETAIL) {
    const text = String(value ?? '').replace(/\u0000/g, '');
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function plainText(value, max = MAX_SUMMARY) {
    return boundedText(value, max).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tryObject(text) {
    try {
        const value = JSON.parse(String(text).trim().replace(/^```json\s*|\s*```$/gi, ''));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_error) {
        return null;
    }
}

function parseFold(content, index) {
    const payload = tryObject(content);
    const source = Array.isArray(payload?.fold_blocks) ? payload.fold_blocks : payload ? [payload] : [];
    const blocks = source.slice(0, 8).map((item, offset) => ({
        title: plainText(item?.title ?? item?.name ?? item?.label ?? `Context ${offset + 1}`, 160) || `Context ${offset + 1}`,
        detail: boundedText(item?.content ?? item?.text ?? item?.body ?? ''),
    }));
    if (blocks.length) return blocks.map((block, offset) => ({
        kind: 'dynamic-fold', summary: block.title, detail: block.detail, index: `${index}.${offset}`,
    }));
    return [{ kind: 'dynamic-fold', summary: `动态上下文 ${index + 1}`, detail: boundedText(content), index: String(index) }];
}

function parseInfo(content, index) {
    const payload = tryObject(content);
    const title = plainText(payload?.title ?? `VCPInfo ${index + 1}`, 160) || `VCPInfo ${index + 1}`;
    const body = boundedText(payload?.body ?? payload?.message ?? content);
    const level = ['info', 'warn', 'error'].includes(payload?.level) ? payload.level : 'info';
    return { kind: 'vcpinfo', summary: `${title}${body ? `：${plainText(body, 800)}` : ''}`, detail: body, level, index: String(index) };
}

function protocolWarning(content, index, reason = '检测到未经允许的 TOOL_REQUEST 标记；已移除且不会执行。') {
    return { kind: 'protocol-warning', summary: reason, detail: boundedText(content), index: String(index) };
}

function historySummary(kind, observation) {
    if (kind === 'dynamic-fold') return `[VCP Fold: ${plainText(observation.summary, 80) || 'Context'}]`;
    if (kind === 'vcpinfo') return `[VCPInfo: ${plainText(observation.summary, 240) || 'notification'}]`;
    return '[VCP protocol marker removed]';
}

function projectVcpContent(value) {
    const text = boundedText(value, 256 * 1024);
    const observations = [];
    let display = '';
    let history = '';
    let cursor = 0;
    let count = 0;
    const starts = Object.entries(MARKERS).map(([kind, pair]) => ({ kind, start: pair[0], end: pair[1] }));
    while (cursor < text.length && count < MAX_MARKERS) {
        let next = null;
        for (const candidate of starts) {
            const position = text.indexOf(candidate.start, cursor);
            if (position >= 0 && (!next || position < next.position)) next = { ...candidate, position };
        }
        if (!next) break;
        const prefix = text.slice(cursor, next.position);
        display += prefix;
        history += prefix;
        const contentStart = next.position + next.start.length;
        const end = text.indexOf(next.end, contentStart);
        if (end < 0) {
            observations.push(protocolWarning(text.slice(contentStart), count, `检测到未闭合的 ${next.kind} 标记；已安全移除。`));
            history += '\n[VCP protocol marker removed]';
            cursor = text.length;
            count += 1;
            break;
        }
        const content = text.slice(contentStart, end);
        const parsed = next.kind === 'fold' ? parseFold(content, count)
            : next.kind === 'info' ? [parseInfo(content, count)] : [protocolWarning(content, count)];
        for (const observation of parsed) {
            observations.push(observation);
            history += `\n${historySummary(observation.kind, observation)}`;
        }
        display += next.kind === 'fold'
            ? `\n[VCP 动态上下文：${parsed.map((item) => plainText(item.summary, 80)).join('；')}]\n`
            : next.kind === 'info' ? '\n[VCP 通知已投影到活动中心]\n' : '\n[VCP 协议标记已移除]\n';
        cursor = end + next.end.length;
        count += 1;
    }
    if (cursor < text.length) {
        display += text.slice(cursor);
        history += text.slice(cursor);
    }
    if (count >= MAX_MARKERS && cursor < text.length) observations.push(protocolWarning('', count, 'VCP 标记数量超过安全上限；剩余内容未作为协议处理。'));
    return {
        text: display.replace(/\n{3,}/g, '\n\n').trim(),
        historyText: history.replace(/\n{3,}/g, '\n\n').trim(),
        observations: observations.slice(0, MAX_MARKERS),
    };
}

module.exports = { MARKERS, projectVcpContent };
