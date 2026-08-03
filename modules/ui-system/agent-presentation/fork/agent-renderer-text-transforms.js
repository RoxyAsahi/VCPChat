function compiledRegex(windowRef, rule) {
    if (!rule?.findPattern) return null;
    if (windowRef.uiHelperFunctions?.getCompiledRegex) {
        return windowRef.uiHelperFunctions.getCompiledRegex(rule.findPattern)?.regex || null;
    }
    if (windowRef.uiHelperFunctions?.regexFromString) {
        return windowRef.uiHelperFunctions.regexFromString(rule.findPattern);
    }
    const match = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
    return match ? new RegExp(match[1], match[2]) : new RegExp(rule.findPattern, 'g');
}

export function createAgentRendererTextTransforms({ window, escapeHtml, transformButton, transformCanvas }) {
    function applyRegexRule(text, rule) {
        if (!rule?.findPattern || typeof text !== 'string') return text;
        try {
            const regex = compiledRegex(window, rule);
            if (!regex) return text;
            regex.lastIndex = 0;
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错:', rule.findPattern, error);
            return text;
        }
    }

    function applyFrontendRegexRules(text, rules, role, depth) {
        if (!Array.isArray(rules) || typeof text !== 'string') return text;
        return rules.filter((rule) => rule && rule.enabled !== false && rule.findPattern
            && rule.applyToFrontend && rule.applyToRoles?.includes(role)
            && (rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth)
            && (rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth))
            .reduce((value, rule) => applyRegexRule(value, rule), text);
    }

    function buildTurnDepthMap(history = []) {
        const turns = [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
            if (history[index].role === 'assistant') {
                const turn = { assistant: history[index], user: null };
                if (index > 0 && history[index - 1].role === 'user') turn.user = history[--index];
                turns.push(turn);
            } else if (history[index].role === 'user') {
                turns.push({ assistant: null, user: history[index] });
            }
        }
        turns.reverse();
        const depths = new Map();
        turns.forEach((turn, index) => {
            const depth = turns.length - 1 - index;
            if (turn.assistant?.id) depths.set(turn.assistant.id, depth);
            if (turn.user?.id) depths.set(turn.user.id, depth);
        });
        return depths;
    }

    function calculateDepthByTurns(messageId, history) {
        return buildTurnDepthMap(history).get(messageId) ?? 0;
    }

    function prepareUserMessageText(text) {
        const images = [];
        let processed = String(text || '').replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match) => {
            if (/on\w+\s*=/i.test(match) || /src\s*=\s*["']\s*javascript:/i.test(match)) return match;
            const placeholder = `__VCP_USER_IMG_${images.length}__`;
            images.push(match);
            return placeholder;
        });
        processed = escapeHtml(processed);
        images.forEach((image, index) => { processed = processed.replace(`__VCP_USER_IMG_${index}__`, image); });
        return transformCanvas(transformButton(processed));
    }

    return { applyFrontendRegexRules, buildTurnDepthMap, calculateDepthByTurns, prepareUserMessageText };
}
