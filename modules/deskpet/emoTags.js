'use strict';

// 桌宠情绪标签：agent 在回复里写 <!--emo:happy 0.8--> 或 <!--emo:happy/bright_smile-->，
// 显示时剥掉，桌宠据此换表情。HTML 注释即使漏剥，Markdown 渲染也不会显示出来。

const EMOTIONS = Object.freeze(['calm', 'focused', 'happy', 'shy', 'surprised', 'sleepy', 'sad', 'annoyed']);

const EMO_TAG_REGEX = /<!--\s*emo\s*:\s*([^\s/>-]+)(?:\/([a-z_]+))?(?:\s+([01](?:\.\d+)?))?\s*-->/gi;

// 注入到 system prompt 末尾的协议说明；只在该 agent 的桌宠打开时注入。
const EMO_PROTOCOL_PROMPT = [
    '【桌宠情绪标记】你的形象会作为桌宠显示在用户桌面上。',
    `在回复开头，以及每段情绪发生变化的话之前，插入一个情绪标记 <!--emo:情绪 强度-->。情绪只能取 ${EMOTIONS.join('/')}，强度是 0 到 1 的小数，例如 <!--emo:happy 0.8-->。`,
    '标记不会显示给用户。不要在代码块、工具调用和日记内容里写标记。',
].join('\n');

function clampIntensity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.7;
    return Math.min(1, Math.max(0, n));
}

/**
 * 增量解析流式文本里的情绪标签。chunk 末尾的半截 "<!--" 会先扣住，等下一段再判断。
 * 代码围栏和 VCP 工具调用块里的标签不算数。
 */
class EmoTagStreamParser {
    constructor({ normalizeEmotion }) {
        this.normalizeEmotion = normalizeEmotion;
        this.pending = '';
        this.inFence = false;
        this.inTool = false;
        this.visibleChars = 0;
    }

    /** @returns {{ tags: Array<{emotion, variant, intensity}>, text: string, toolOpened: boolean, toolClosed: boolean }} */
    push(chunk) {
        let text = this.pending + String(chunk || '');
        this.pending = '';
        const tail = text.lastIndexOf('<!--');
        if (tail !== -1 && text.indexOf('-->', tail) === -1 && text.length - tail < 64) {
            this.pending = text.slice(tail);
            text = text.slice(0, tail);
        } else {
            // 末尾是 "<"、"<!"、"<!-" 时也先扣住，可能是下一个标签的开头。
            const partial = /<(?:!-?)?$/.exec(text);
            if (partial) {
                this.pending = partial[0];
                text = text.slice(0, partial.index);
            }
        }
        return this._scan(text);
    }

    flush() {
        const text = this.pending;
        this.pending = '';
        return this._scan(text);
    }

    _scan(text) {
        const tags = [];
        let toolOpened = false;
        let toolClosed = false;
        // 逐段切开：围栏、工具块标记和情绪标签按出现顺序处理。
        const tokenRegex = /```|<<<\[TOOL_REQUEST\]>>>|<<<\[END_TOOL_REQUEST\]>>>|<!--\s*emo\s*:[^>]*-->/gi;
        let match;
        let plain = '';
        let cursor = 0;
        while ((match = tokenRegex.exec(text)) !== null) {
            const token = match[0];
            if (!this.inFence && !this.inTool) plain += text.slice(cursor, match.index);
            cursor = match.index + token.length;
            if (token === '```') {
                if (!this.inTool) this.inFence = !this.inFence;
            } else if (/^<<<\[TOOL_REQUEST\]>>>$/i.test(token)) {
                if (!this.inFence) { this.inTool = true; toolOpened = true; }
            } else if (/^<<<\[END_TOOL_REQUEST\]>>>$/i.test(token)) {
                if (this.inTool) { this.inTool = false; toolClosed = true; }
            } else if (!this.inFence && !this.inTool) {
                const parsed = parseEmoTag(token, this.normalizeEmotion);
                if (parsed) tags.push({ ...parsed, offset: this.visibleChars + plain.length });
            }
        }
        if (!this.inFence && !this.inTool) plain += text.slice(cursor);
        this.visibleChars += plain.length;
        return { tags, text: plain, toolOpened, toolClosed };
    }
}

function parseEmoTag(token, normalizeEmotion) {
    EMO_TAG_REGEX.lastIndex = 0;
    const match = EMO_TAG_REGEX.exec(token);
    EMO_TAG_REGEX.lastIndex = 0;
    if (!match) return null;
    const emotion = normalizeEmotion ? normalizeEmotion(match[1]) : String(match[1]).toLowerCase();
    if (!emotion || !EMOTIONS.includes(emotion)) return null;
    return {
        emotion,
        variant: match[2] ? match[2].toLowerCase() : null,
        intensity: clampIntensity(match[3] == null ? 0.7 : match[3]),
    };
}

function stripEmoTags(text) {
    if (typeof text !== 'string' || text.indexOf('emo') === -1) return text;
    return text.replace(/<!--\s*emo\s*:[^>]*?-->/gi, '');
}

module.exports = {
    EMOTIONS,
    EMO_PROTOCOL_PROMPT,
    EmoTagStreamParser,
    parseEmoTag,
    stripEmoTags,
};
