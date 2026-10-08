// Copied from TsukuMate (src/shared/emotion/chat-emotion-classifier.js), written by
// the same author as this VCPChat integration and reused here with her permission
// (2026-10-08). Rule-based fallback classifier for the desk pet when a reply
// carries no <!--emo:...--> tag.
"use strict";

const EMOTIONS = ["calm", "focused", "happy", "shy", "surprised", "sleepy", "sad", "annoyed"];
const ACTIVE_EMOTIONS = EMOTIONS.filter((emotion) => emotion !== "calm");
const MOOD_ACTIONS = new Set(["preserve", "establish", "reinforce", "ease", "resolve", "replace"]);

const TOKEN_ALIASES = new Map([
  ["calm", "calm"], ["neutral", "calm"], ["平静", "calm"], ["平靜", "calm"], ["冷静", "calm"],
  ["focused", "focused"], ["focus", "focused"], ["专注", "focused"], ["專注", "focused"], ["集中", "focused"],
  ["happy", "happy"], ["joy", "happy"], ["joyful", "happy"], ["开心", "happy"], ["開心", "happy"], ["高兴", "happy"], ["高興", "happy"], ["嬉しい", "happy"],
  ["shy", "shy"], ["embarrassed", "shy"], ["bashful", "shy"], ["害羞", "shy"], ["照れ", "shy"], ["羞涩", "shy"], ["羞澀", "shy"],
  ["surprised", "surprised"], ["surprise", "surprised"], ["shocked", "surprised"], ["惊讶", "surprised"], ["驚訝", "surprised"], ["惊喜", "surprised"], ["驚喜", "surprised"], ["驚き", "surprised"],
  ["sleepy", "sleepy"], ["tired", "sleepy"], ["困倦", "sleepy"], ["困", "sleepy"], ["疲惫", "sleepy"], ["疲憊", "sleepy"], ["眠い", "sleepy"],
  ["sad", "sad"], ["sadness", "sad"], ["upset", "sad"], ["难过", "sad"], ["難過", "sad"], ["伤心", "sad"], ["傷心", "sad"], ["委屈", "sad"], ["悲しい", "sad"],
  ["annoyed", "annoyed"], ["angry", "annoyed"], ["anger", "annoyed"], ["mad", "annoyed"], ["生气", "annoyed"], ["生氣", "annoyed"], ["愤怒", "annoyed"], ["憤怒", "annoyed"], ["不满", "annoyed"], ["不滿", "annoyed"], ["怒り", "annoyed"],
]);

function normalizeEmotionToken(value) {
  const token = String(value == null ? "" : value).trim().toLowerCase().replace(/[\s_.-]+/g, " ");
  if (!token) return null;
  if (TOKEN_ALIASES.has(token)) return TOKEN_ALIASES.get(token);
  for (const [alias, emotion] of TOKEN_ALIASES) {
    if (alias.length >= 2 && token.includes(alias)) return emotion;
  }
  return null;
}

const COMPOUND_NAMES = new Map([
  ["happy|shy", "shy-joy"],
  ["happy|surprised", "pleasant-surprise"],
  ["happy|sad", "bittersweet"],
  ["annoyed|sad", "grievance"],
  ["sad|surprised", "stunned-sadness"],
  ["annoyed|surprised", "shocked-annoyance"],
  ["sad|sleepy", "weary-sadness"],
]);

function compoundNameFor(primary, secondary) {
  if (!secondary || primary === secondary) return undefined;
  return COMPOUND_NAMES.get([primary, secondary].sort().join("|")) || "mixed";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeEmotionBlend(input, defaultSource = "fallback") {
  if (typeof input === "string") {
    const primary = normalizeEmotionToken(input) || "calm";
    return { primary, primaryWeight: 1, secondaryWeight: 0, intensity: primary === "calm" ? 0.2 : 0.75, source: defaultSource };
  }
  const value = input && typeof input === "object" ? input : {};
  const primary = normalizeEmotionToken(value.primary || value.emotion || value.mood || value.label) || "calm";
  let secondary = normalizeEmotionToken(value.secondary);
  if (!secondary || secondary === primary || secondary === "calm" || primary === "calm") secondary = undefined;
  let primaryWeight = Number(value.primaryWeight ?? (Array.isArray(value.weights) ? value.weights[0] : undefined));
  let secondaryWeight = Number(value.secondaryWeight ?? (Array.isArray(value.weights) ? value.weights[1] : undefined));
  if (!secondary) {
    primaryWeight = 1;
    secondaryWeight = 0;
  } else {
    if (!Number.isFinite(primaryWeight) || primaryWeight <= 0) primaryWeight = 0.7;
    if (!Number.isFinite(secondaryWeight) || secondaryWeight <= 0) secondaryWeight = 0.3;
    const total = primaryWeight + secondaryWeight;
    primaryWeight /= total;
    secondaryWeight /= total;
  }
  const rawIntensity = Number(value.intensity);
  const intensity = Number.isFinite(rawIntensity)
    ? clamp(rawIntensity, 0.2, 1)
    : (primary === "calm" ? 0.2 : 0.75);
  const source = ["heuristic", "api", "fallback"].includes(value.source) ? value.source : defaultSource;
  return {
    primary,
    ...(secondary ? { secondary } : {}),
    primaryWeight,
    secondaryWeight,
    intensity,
    ...(secondary ? { compoundName: compoundNameFor(primary, secondary) } : {}),
    source,
  };
}

function parseJsonCandidates(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { text, candidates: [] };
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [unfenced];
  const objectMatch = unfenced.match(/\{[\s\S]*?\}/);
  if (objectMatch && objectMatch[0] !== unfenced) candidates.push(objectMatch[0]);
  return { text: unfenced, candidates };
}

function normalizeMoodAction(value) {
  const action = String(value || "").trim().toLowerCase();
  return MOOD_ACTIONS.has(action) ? action : "preserve";
}

function parseEmotionDecisionResponse(raw) {
  const { text, candidates } = parseJsonCandidates(raw);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!normalizeEmotionToken(parsed && (parsed.primary || parsed.emotion || parsed.mood || parsed.label))) continue;
      return {
        blend: normalizeEmotionBlend({ ...parsed, source: "api" }, "api"),
        moodAction: normalizeMoodAction(parsed.moodAction || parsed.mood_action),
      };
    } catch {}
  }
  // A streamed JSON object may already contain the primary label before its
  // weights arrive. Do not mistake that incomplete object for a legacy label.
  const legacy = text.includes("{") ? null : normalizeEmotionToken(text);
  return legacy ? { blend: normalizeEmotionBlend(legacy, "api"), moodAction: "preserve" } : null;
}

function parseEmotionBlendResponse(raw) {
  const decision = parseEmotionDecisionResponse(raw);
  return decision ? decision.blend : null;
}

function parseEmotionResponse(raw) {
  const blend = parseEmotionBlendResponse(raw);
  return blend ? blend.primary : null;
}

function extractAssistantText(result) {
  const choice = result && result.choices && result.choices[0];
  const message = choice && choice.message;
  const content = message && message.content;
  const contentText = Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : String(part && (part.text || part.content) || "")).join("\n")
    : String(content == null ? "" : content);
  return [contentText, message && message.reasoning_content, choice && choice.text]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
}

// Rules are deliberately phrase-oriented. Each accepted span contributes one
// vector, so a multidimensional phrase never needs two overlapping matches.
const VECTOR_RULES = [
  { pattern: /没有生[气氣]|不生[气氣]|并不讨厌|並不討厭|不讨厌|不討厭|不难过|不難過|不累|not\s+(?:angry|mad|sad|tired)|(?:do not|don't)\s+hate/gi, scores: {} },
  { pattern: /不开心|不開心|不高兴|不高興|not\s+happy/gi, scores: { sad: 6 } },
  { pattern: /不满意|不滿意|不满足|不滿足|not\s+satisfied/gi, scores: { annoyed: 5 } },
  { pattern: /害羞|不好意思|脸红|臉紅|羞涩|羞澀|暧昧|曖昧|喜欢你|喜歡你|爱你|愛你|照れ|恥ずかし|\bshy\b|\bembarrassed?\b|\bblush(?:ed|ing)?\b/gi, scores: { shy: 6, happy: 2 } },
  { pattern: /绝望|絕望|despair|hopeless/gi, scores: { sad: 6, surprised: 3 } },
  { pattern: /怎么办|怎麼辦|救命|紧急|緊急|出事|事故|危险|危險|被抢|被搶|失窃|失竊|emergency|panic|urgent|locked|ruined/gi, scores: { surprised: 6, sad: 3 } },
  { pattern: /惊讶|驚訝|吓一跳|嚇一跳|惊呆|驚呆|真的假的|びっくり|驚き|\bsurpris(?:e|ed|ing)?\b|\bshock(?:ed|ing)?\b|unexpected/gi, scores: { surprised: 6 } },
  { pattern: /惊喜|驚喜|没想到|沒想到|居然|突然|\bwow\b|hooray|yippee/gi, scores: { surprised: 4, happy: 3 } },
  { pattern: /垃圾|骗子|騙子|无语|無語|恶心|噁心|闭嘴|閉嘴|滚|滾|废话|廢話|白痴|差劲|差勁|气死|氣死|愤怒|憤怒|生气|生氣|不爽|むかつ|怒り|\bannoy(?:ed|ing)?\b|\bangry\b|\bmad\b|damn|fuck|shut\s+up|idiot|horrible|terrible/gi, scores: { annoyed: 6 } },
  { pattern: /烦|煩|讨厌|討厭|不喜欢|不喜歡|投诉|投訴|差评|差評|退款|退钱|退錢|卡顿|卡頓|报错|報錯|崩溃|崩潰|卸载|卸載|太慢|不好用|没用|沒用|故障|死机|死機|complain|refund|crash|\blag\b|\berror\b|\bfailed\b|useless|\bbug\b|uninstall/gi, scores: { annoyed: 3 } },
  { pattern: /难过|難過|伤心|傷心|委屈|失望|后悔|後悔|孤独|孤獨|痛苦|不想说了|不想說了|算了吧|再见|再見|悲し|寂し|\bsad\b|\bupset\b|disappoint|regret|lonely|give\s+up|unfortunately|alas/gi, scores: { sad: 6 } },
  { pattern: /哭|受伤|受傷|损失|損失|丢了|丟了|没了|沒了|\bhurt\b|\bcry(?:ing)?\b|\blost\b|damaged/gi, scores: { sad: 4, surprised: 2 } },
  { pattern: /困倦|好困|想睡|晚安|睡觉|睡覺|累死|眠い|眠たい|\bsleepy\b|exhaust/gi, scores: { sleepy: 6 } },
  { pattern: /疲惫|疲憊|累了|太累|乏力|\btired\b|fatigue/gi, scores: { sleepy: 4 } },
  { pattern: /开心|開心|高兴|高興|太好了|成功了|完成了|修好了|幸福|万岁|萬歲|有心了|うれし|嬉し|楽しい|\bhappy\b|\bglad\b|awesome|hooray|great\s+news/gi, scores: { happy: 5 } },
  { pattern: /谢谢|謝謝|感谢|感謝|多亏|多虧|辛苦了|喜欢|喜歡|爱了|愛了|感恩|棒|优秀|優秀|完美|厉害|厲害|聪明|聰明|专业|專業|靠谱|靠譜|真快|懂我|绝了|絕了|点赞|點讚|\bthank(?:s|\s+you)?\b|grateful|appreciate|\bgreat\b|\bperfect\b|amazing|brilliant|\bcool\b|\bsuper\b|\blove\b/gi, scores: { happy: 4 } },
  { pattern: /没错|沒錯|赞同|贊同|支持|认可|認可|可以|没问题|沒問題|好用|实用|實用|正确|正確|\byes\b|\bcorrect\b|\bagree\b|\bok(?:ay)?\b|useful|solved/gi, scores: { happy: 1 } },
  { pattern: /分析|研究|认真|認真|专注|專注|仔细|仔細|解释|解釋|学习|學習|代码|代碼|文件|方案|计划|計畫|步骤|步驟|方法|查询|查詢|搜索|搜尋|修改|生成|翻译|翻譯|調べ|集中|\bfocus(?:ed)?\b|analy|study|explain|debug|\bcode\b|steps|method|search|edit|generate|translate/gi, scores: { focused: 3 } },
  { pattern: /请问|請問|怎么|怎麼|如何|为什么|為什麼|什么|什麼|多少|哪里|哪裡|帮我|幫我|打开|打開|关闭|關閉|显示|顯示|状态|狀態|进度|進度|数据|數據|内容|內容|文档|文檔|格式|版本|功能|设置|設置|更新|结果|結果|\bhow\b|\bwhat\b|\bwhy\b|\bwhere\b|\bwhen\b|\bplease\b|question|show|display|status|progress|data|format|version|setting|update|result/gi, scores: { focused: 2 } },
];

const TIE_PRIORITY = ["shy", "surprised", "annoyed", "sad", "sleepy", "happy", "focused"];
const AFFECT_EMOTIONS = TIE_PRIORITY.filter((emotion) => emotion !== "focused");

function collectMatches(text) {
  const matches = [];
  VECTOR_RULES.forEach((rule, ruleIndex) => {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (!match[0]) continue;
      matches.push({ start: match.index, end: match.index + match[0].length, text: match[0], scores: rule.scores, ruleIndex });
    }
  });
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.ruleIndex - b.ruleIndex);
  const accepted = [];
  for (const candidate of matches) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function contextMultiplier(text, match) {
  const before = text.slice(Math.max(0, match.start - 24), match.start);
  let multiplier = 1;
  if (/(?:非常|極其|极其|特别|特別|真的太|really|very)\s*$/i.test(before)) multiplier *= 2;
  else if (/(?:很|太|真|so)\s*$/i.test(before)) multiplier *= 1.5;
  else if (/(?:有点|有點|有些|稍微|a\s+little|a\s+bit)\s*$/i.test(before)) multiplier *= 0.5;
  if (/(?:没有|沒有|并不|並不|不是|不太|没|沒|不|not|never|don't|do\s+not)\s*$/i.test(before)) multiplier *= 0.2;
  return multiplier;
}

function clauseMultiplier(text, index) {
  const contrast = /但是|但|不过|不過|可是|然而|\bbut\b|\byet\b|でも|しかし/gi;
  const markers = [...text.matchAll(contrast)];
  if (!markers.length) return 1;
  const marker = markers[markers.length - 1];
  return index < marker.index ? 0.8 : 1.25;
}

function scoreEmotionText(input) {
  const text = String(input || "").slice(0, 2000);
  const scores = Object.fromEntries(ACTIVE_EMOTIONS.map((emotion) => [emotion, 0]));
  for (const match of collectMatches(text)) {
    const multiplier = contextMultiplier(text, match) * clauseMultiplier(text, match.start);
    for (const [emotion, value] of Object.entries(match.scores)) scores[emotion] += value * multiplier;
  }

  const hasAffect = AFFECT_EMOTIONS.some((emotion) => scores[emotion] > 0);
  if (hasAffect) scores.focused = 0;
  const topAffect = AFFECT_EMOTIONS.reduce((best, emotion) => scores[emotion] > scores[best] ? emotion : best, AFFECT_EMOTIONS[0]);
  let intensityBonus = 0;
  if (/[!！]{2,}/.test(text)) {
    intensityBonus += 0.1;
    if (hasAffect) scores[topAffect] += 1;
  }
  if (/[?？]{2,}/.test(text)) {
    intensityBonus += 0.12;
    if (scores.surprised > 0 || !hasAffect) scores.surprised += 3;
    else scores[topAffect] += 1;
  }
  const emojiSignals = [
    { pattern: /[😊😄😁🎉👍❤❤️]/u, emotion: "happy", score: 4 },
    { pattern: /[😢😭💔]/u, emotion: "sad", score: 5 },
    { pattern: /[😡🤬]/u, emotion: "annoyed", score: 6 },
    { pattern: /[😳🙈]/u, emotion: "shy", score: 5 },
    { pattern: /[😮😲]/u, emotion: "surprised", score: 5 },
    { pattern: /[😴🥱]/u, emotion: "sleepy", score: 5 },
  ];
  for (const signal of emojiSignals) {
    if (!signal.pattern.test(text)) continue;
    const nowHasAffect = AFFECT_EMOTIONS.some((emotion) => scores[emotion] > 0);
    if (!nowHasAffect || scores[signal.emotion] > 0) scores[signal.emotion] += signal.score;
    intensityBonus += 0.08;
  }

  const ordered = TIE_PRIORITY.map((emotion, priority) => ({ emotion, score: scores[emotion], priority }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.priority - b.priority);
  if (!ordered.length) {
    const blend = normalizeEmotionBlend({ primary: "calm", intensity: 0.2, source: "fallback" });
    return { emotion: "calm", score: 0, scores, blend };
  }
  const first = ordered[0];
  const second = ordered.find((entry, index) => index > 0 && entry.emotion !== "focused" && entry.score >= 3 && entry.score >= first.score * 0.4);
  let blend;
  if (second) {
    const total = first.score + second.score;
    blend = normalizeEmotionBlend({
      primary: first.emotion,
      secondary: second.emotion,
      primaryWeight: first.score / total,
      secondaryWeight: second.score / total,
      intensity: clamp(first.score / 8 + intensityBonus, 0.2, 1),
      source: "heuristic",
    }, "heuristic");
  } else {
    blend = normalizeEmotionBlend({
      primary: first.emotion,
      intensity: clamp(first.score / 8 + intensityBonus, 0.2, 1),
      source: "heuristic",
    }, "heuristic");
  }
  return { emotion: blend.primary, score: first.score, scores, blend };
}

function inferEmotionBlendFromText(input) {
  return scoreEmotionText(input).blend;
}

function inferEmotionFromText(input) {
  const result = scoreEmotionText(input);
  return result.score > 0 ? result.blend.primary : null;
}

function inferMoodActionFromText(input, blendValue) {
  const text = String(input || "").trim().slice(0, 2000);
  const blend = normalizeEmotionBlend(blendValue || inferEmotionBlendFromText(text), "heuristic");
  // Negative continuations must win before the positive fragments contained
  // inside them ("还没好" contains "好"). Local fallback is deliberately
  // conservative; nuanced recovery remains the API classifier's job.
  if (/(?:还|仍然|依然|并|並)?(?:没|沒有|没有|未)(?:有)?(?:好|恢复|恢復|释怀|釋懷|缓解|緩解)|并没有好|並沒有好|not\s+(?:okay|better|fine)|still\s+(?:sad|upset|angry|tired)|まだ(?:だめ|辛い|悲しい|怒って)|아직\s*(?:안\s*)?(?:괜찮|나아)/i.test(text)) {
    return "preserve";
  }
  if (/(?:我)?(?:已经|已經)?(?:没事了|沒事了|好多了|恢复了|恢復了|释怀了|釋懷了)|谢谢你安慰我|謝謝你安慰我|被你安慰好了|心情恢复了|心情恢復了|i(?:'m| am)\s+(?:okay|fine|better)\s+now|i\s+feel\s+better\s+now|もう大丈夫|元気になった|이제\s*괜찮|기분이\s*나아졌/i.test(text)) {
    return "resolve";
  }
  if (/(?:稍微|有点|有點|一点|一點)(?:好|舒服|轻松|輕鬆)(?:一点|一點)?|好一点了|好一點了|缓解了一些|緩解了一些|a\s+(?:little|bit)\s+better|少し(?:楽|良く)なった|조금\s*나아/i.test(text)) {
    return "ease";
  }
  if (blend.primary !== "calm" && blend.primary !== "focused" && blend.intensity >= 0.55) return "establish";
  return "preserve";
}

module.exports = {
  EMOTIONS,
  normalizeEmotionToken,
  normalizeEmotionBlend,
  normalizeMoodAction,
  compoundNameFor,
  parseEmotionResponse,
  parseEmotionBlendResponse,
  parseEmotionDecisionResponse,
  extractAssistantText,
  scoreEmotionText,
  inferEmotionBlendFromText,
  inferEmotionFromText,
  inferMoodActionFromText,
};
