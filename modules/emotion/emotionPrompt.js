/* The short system prompt addition that asks an agent to tag its own emotions.
 * Only sent for agents that have something to show it with (expression variant portraits today,
 * a desk pet later), and skipped when the agent's own prompt already describes the tag. */
import { EMOTIONS } from './emotionVocabulary.js';

export const EMOTION_TAG_PROMPT = [
    '【表情标记】你的立绘会随你的情绪换表情。',
    '请在回复开头、以及情绪明显变化的那句话前面，插入一个情绪标记 <!--emo:情绪 强度-->，例如 <!--emo:happy 0.8-->。',
    `情绪只能从这些词里选：${EMOTIONS.join(' ')}；强度是 0 到 1 的数字。`,
    '标记不会显示给用户，不要解释它，也不要把它写进代码块、工具调用或日记里。',
].join('\n');

/** 要不要给这个 agent 加表情标记的说明：有地方显示、没关掉、自己的提示词里也还没写 */
export function shouldAddEmotionTagPrompt({ systemPrompt = '', enabled = true, hasDisplay = false } = {}) {
    if (!hasDisplay || enabled === false) return false;
    return !/<!--\s*emo\s*[:：]/i.test(String(systemPrompt || ''));
}
