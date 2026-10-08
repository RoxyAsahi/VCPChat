/* Inline emotion tags in assistant replies: <!--emo:happy 0.8-->.
 * stripEmotionTags() removes them from anything a person sees or hears; createEmotionTagScanner()
 * reads a streamed reply chunk by chunk and reports tags, visible text and the regions (code,
 * thoughts, tool calls) where tags do not count. No DOM or Electron dependency. */
import { normalizeEmotion, clampIntensity } from './emotionVocabulary.js';

// <!--emo:happy-->、<!--emo:happy 0.8-->、<!--emo:happy/bright_smile 0.8-->、<!-- emo: 开心 -->
const TAG_BODY = /^\s*emo\s*[:：]\s*([^\s/>]+?)(?:\/([A-Za-z0-9_-]+))?(?:\s+([01](?:\.\d+)?|\.\d+))?\s*$/i;
const COMPLETE_TAG = /<!--\s*emo\s*[:：][\s\S]*?-->/gi;
// 流式尾巴上还没写完的标签：<!-、<!--、<!--em、<!--emo:hap…（最多 64 个字符，避免吞掉普通长注释）
const PARTIAL_TAIL = /<!(?:-(?:-(?:\s*e(?:m(?:o(?:\s*[:：][^>]{0,64})?)?)?)?)?)?$/i;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** 解析一个注释体（<!-- 和 --> 之间的部分）；不是情绪标签或情绪认不出时返回 null */
export function parseEmotionTagBody(body) {
    const match = TAG_BODY.exec(String(body ?? ''));
    if (!match) return null;
    const emotion = normalizeEmotion(match[1]);
    if (!emotion) return null;
    return { emotion, variant: match[2] ? match[2].toLowerCase() : null, intensity: clampIntensity(match[3], 0.7) };
}

function stripOutsideFences(text, streaming) {
    let result = text.replace(COMPLETE_TAG, '');
    if (streaming) result = result.replace(PARTIAL_TAIL, '');
    return result;
}

/**
 * 去掉文本里的情绪标签。代码围栏里的不动（那是在讲这个格式，不是在用它）。
 * streaming 为 true 时连尾巴上没写完的半个标签一起去掉，免得流式中途闪出 "<!--emo"。
 */
export function stripEmotionTags(text, { streaming = false } = {}) {
    if (typeof text !== 'string' || !text) return text;
    if (!/<!/.test(text)) return text;
    let result = '';
    let cursor = 0;
    FENCE.lastIndex = 0;
    let match;
    while ((match = FENCE.exec(text)) !== null) {
        if (match[0] === '') { FENCE.lastIndex += 1; continue; }
        result += stripOutsideFences(text.slice(cursor, match.index), false);
        result += match[0];
        cursor = match.index + match[0].length;
    }
    result += stripOutsideFences(text.slice(cursor), streaming && cursor < text.length);
    return result;
}

// 不计入情绪的区域：代码、思维链、工具调用与工具结果。区域里的标签不算，文字也不拿去做规则判断
const REGIONS = Object.freeze([
    { kind: 'code', open: '```', close: '```' },
    { kind: 'thought', open: '<think>', close: '</think>' },
    { kind: 'thought', open: '<thinking>', close: '</thinking>' },
    { kind: 'tool', open: '<<<[TOOL_REQUEST]>>>', close: '<<<[END_TOOL_REQUEST]>>>' },
    { kind: 'tool', open: '[[VCP调用结果信息汇总:', close: 'VCP调用结果结束]]' },
]);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const OPENERS = [COMMENT_OPEN, ...REGIONS.map(region => region.open)];
// 超过这个长度还没闭合的注释不再等，当作普通注释跳过开头继续读
const MAX_PENDING_COMMENT = 240;

// 文本末尾可能是某个开标记的前半截时，留着等下一块再判断
function heldTailLength(text, markers) {
    let held = 0;
    for (const marker of markers) {
        for (let length = Math.min(marker.length - 1, text.length); length > held; length -= 1) {
            if (text.endsWith(marker.slice(0, length))) { held = length; break; }
        }
    }
    return held;
}

/**
 * 增量读取一条流式回复。push(delta) 返回这一块里新确定的事件：
 *   { type: 'text', text }                    正文里可见的文字（已去掉标签和各区域）
 *   { type: 'tag', emotion, variant, intensity }
 *   { type: 'enter', region } / { type: 'exit', region }   region 为 code | thought | tool
 * finish() 把留着的尾巴当正文吐出来。
 */
export function createEmotionTagScanner() {
    let buffer = '';
    let region = null;

    function scan(final) {
        const events = [];
        let cursor = 0;
        while (cursor < buffer.length) {
            if (region) {
                const closeAt = buffer.indexOf(region.close, cursor);
                if (closeAt === -1) {
                    cursor = final ? buffer.length : Math.max(cursor, buffer.length - (region.close.length - 1));
                    break;
                }
                cursor = closeAt + region.close.length;
                events.push({ type: 'exit', region: region.kind });
                region = null;
                continue;
            }
            let nextAt = -1;
            let opener = null;
            for (const candidate of OPENERS) {
                const at = buffer.indexOf(candidate, cursor);
                if (at !== -1 && (nextAt === -1 || at < nextAt)) { nextAt = at; opener = candidate; }
            }
            if (nextAt === -1) {
                const keep = final ? 0 : heldTailLength(buffer.slice(cursor), OPENERS);
                const end = buffer.length - keep;
                if (end > cursor) events.push({ type: 'text', text: buffer.slice(cursor, end) });
                cursor = end;
                break;
            }
            if (nextAt > cursor) events.push({ type: 'text', text: buffer.slice(cursor, nextAt) });
            cursor = nextAt;
            if (opener === COMMENT_OPEN) {
                const closeAt = buffer.indexOf(COMMENT_CLOSE, cursor + COMMENT_OPEN.length);
                if (closeAt === -1) {
                    if (!final && buffer.length - cursor < MAX_PENDING_COMMENT) break;
                    cursor += COMMENT_OPEN.length;
                    continue;
                }
                const tag = parseEmotionTagBody(buffer.slice(cursor + COMMENT_OPEN.length, closeAt));
                if (tag) events.push({ type: 'tag', ...tag });
                cursor = closeAt + COMMENT_CLOSE.length;
                continue;
            }
            region = REGIONS.find(candidate => candidate.open === opener);
            cursor += opener.length;
            events.push({ type: 'enter', region: region.kind });
        }
        buffer = buffer.slice(cursor);
        return events;
    }

    return Object.freeze({
        push(delta) {
            if (typeof delta !== 'string' || !delta) return [];
            buffer += delta;
            return scan(false);
        },
        finish() {
            const events = scan(true);
            if (region) {
                events.push({ type: 'exit', region: region.kind });
                region = null;
            }
            buffer = '';
            return events;
        },
        get region() { return region?.kind || null; },
    });
}
