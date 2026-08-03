// --- LaTeX Protection ---
// 用于在 marked 解析前保护 LaTeX 块，防止 Markdown 解析器破坏 LaTeX 语法
// （如 \\ 被当作转义、_ 被当作斜体等）

/**
 * 在 marked 解析前保护 LaTeX 块，用占位符替换。
 * 必须在 preprocessFullContent 之后、markedInstance.parse 之前调用。
 * @param {string} text 预处理后的文本
 * @returns {{text: string, map: Map<string, string>}} 替换后的文本和映射表
 */
function protectLatexBlocks(text) {
    const map = new Map();
    let id = 0;

    const createLatexPlaceholder = (latexSource) => {
        const placeholder = `%%LATEX_BLOCK_${id}%%`;
        map.set(placeholder, latexSource);
        id++;
        return placeholder;
    };

    const looksLikeSafeSingleDollarMath = (content) => {
        const trimmedContent = (content || '').trim();
        if (!trimmedContent) return false;

        const hasExplicitMathSignal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(trimmedContent);
        const isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(trimmedContent);
        const isSimpleIdentifierMath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedContent);

        // 数字开头的候选仍需严格检查，避免把价格与价格单位误当作公式。
        // `$1$`、`$20\%$`、`$2^n$`、`$1/2$` 等明确闭合数学保持放行；
        // 真正的价格通常是 `$123` 后接普通文本而没有闭合 `$`。
        if (/^\d/.test(trimmedContent) && !hasExplicitMathSignal && !isSimpleNumericMath) return false;

        // 路径、模板表达式与 Markdown 表格跨列候选继续排除。
        // 闭合的 `$x$`、`$n$`、`$abc$` 视为标准行内数学；
        // 不闭合的 `$PATH` 不会被扫描器选为候选，因此无需按标识符统一拒绝。
        if (trimmedContent.startsWith('/')) return false;
        if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) return false;
        if (trimmedContent.includes('|')) return false;

        return hasExplicitMathSignal || isSimpleNumericMath || isSimpleIdentifierMath;
    };

    const protectInlineDollarMathInText = (source) => {
        let result = '';
        let index = 0;

        while (index < source.length) {
            const openIndex = source.indexOf('$', index);
            if (openIndex === -1) {
                result += source.slice(index);
                break;
            }

            result += source.slice(index, openIndex);

            const previousChar = source[openIndex - 1] || '';
            const nextOpenChar = source[openIndex + 1] || '';

            // 开始符不能是转义美元、双美元、单词内部美元。
            if (previousChar === '\\' || previousChar === '$' || nextOpenChar === '$' || /\w/.test(previousChar)) {
                result += '$';
                index = openIndex + 1;
                continue;
            }

            let closeIndex = -1;
            let cursor = openIndex + 1;
            while (cursor < source.length) {
                const dollarIndex = source.indexOf('$', cursor);
                if (dollarIndex === -1) break;

                if (source[dollarIndex - 1] === '\\') {
                    cursor = dollarIndex + 1;
                    continue;
                }

                const nextCloseChar = source[dollarIndex + 1] || '';
                if (!/\w/.test(nextCloseChar)) {
                    closeIndex = dollarIndex;
                    break;
                }

                cursor = dollarIndex + 1;
            }

            if (closeIndex === -1) {
                result += '$';
                index = openIndex + 1;
                continue;
            }

            const content = source.slice(openIndex + 1, closeIndex);
            if (content.length > 1200 || content.includes('\n') || !looksLikeSafeSingleDollarMath(content)) {
                // 不安全候选只释放开头 $，不吞掉到下一个 $ 的整段文本；
                // 这样 "$12.5 ... $2.49 ... $\Delta...$" 不会因价格误配而跳过后续真公式。
                result += '$';
                index = openIndex + 1;
                continue;
            }

            result += createLatexPlaceholder(`\\(${content.trim()}\\)`);
            index = closeIndex + 1;
        }

        return result;
    };

    const protectInlineDollarMath = (source) => {
        // HTML 标签是硬边界：美元定界符只能在同一个纯文本片段内闭合。
        // 这既避免读取 style/data 属性中的 `$`，也避免把
        // `<strong>$35.50</strong> ... <span>$12.25</span>` 跨元素配成公式。
        // 仅识别形似真实标签的片段，数学表达式中的比较运算符 `<`、`>` 仍留在文本中。
        const htmlTagRegex = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'"<>])*)?\s*\/?>/g;
        let result = '';
        let cursor = 0;
        let tagMatch;

        while ((tagMatch = htmlTagRegex.exec(source)) !== null) {
            result += protectInlineDollarMathInText(source.slice(cursor, tagMatch.index));
            result += tagMatch[0];
            cursor = tagMatch.index + tagMatch[0].length;
        }

        result += protectInlineDollarMathInText(source.slice(cursor));
        return result;
    };

    // 🟢 关键修复：先保护代码围栏，防止代码块内的 $ / $$ 被误匹配为 LaTeX
    // 例如 Python 代码 `b'$$' in data` 中的 $$ 会与文档后面的 $$ 数学公式匹配，
    // 导致 LaTeX 占位符跨越并吞噬中间的代码围栏标记
    const codeFenceMap = new Map();
    let codeFenceId = 0;

    // 使用逐行状态机识别代码围栏（比正则更可靠）
    const lines = text.split('\n');
    const resultLines = [];
    let fenceStartLine = -1;
    let fenceBacktickCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();

        if (fenceStartLine === -1) {
            // 不在代码块内：检测开始围栏
            const openMatch = trimmed.match(/^(`{3,})/);
            if (openMatch) {
                fenceStartLine = resultLines.length;
                fenceBacktickCount = openMatch[1].length;
                resultLines.push(lines[i]);
            } else {
                resultLines.push(lines[i]);
            }
        } else {
            // 在代码块内：检测关闭围栏
            const closeMatch = trimmed.match(/^(`{3,})\s*$/);
            if (closeMatch && closeMatch[1].length >= fenceBacktickCount) {
                // 找到关闭围栏，将整个代码块替换为占位符
                resultLines.push(lines[i]);
                const blockLines = resultLines.splice(fenceStartLine);
                const blockContent = blockLines.join('\n');
                const placeholder = `%%CODEFENCE_FOR_LATEX_${codeFenceId}%%`;
                codeFenceMap.set(placeholder, blockContent);
                codeFenceId++;
                resultLines.push(placeholder);
                fenceStartLine = -1;
                fenceBacktickCount = 0;
            } else {
                resultLines.push(lines[i]);
            }
        }
    }

    // 如果有未关闭的代码围栏（流式传输场景），也保护起来
    if (fenceStartLine !== -1) {
        const blockLines = resultLines.splice(fenceStartLine);
        const blockContent = blockLines.join('\n');
        const placeholder = `%%CODEFENCE_FOR_LATEX_${codeFenceId}%%`;
        codeFenceMap.set(placeholder, blockContent);
        codeFenceId++;
        resultLines.push(placeholder);
    }

    let processed = resultLines.join('\n');

    // 保护顺序很重要：先保护 display math ($$...$$)，再保护 inline math。
    // 块级 $$ 只接受“独占一行”的定界符，避免把 `$10`、`$$` 字符串或表格内容误贪成跨段公式。
    // 同时保护 \[...\] 和 \(...\)。

    // 1. 保护 $$...$$ (display math)。
    // 支持两种常见模型输出：
    //   A) 定界符独占行：
    //      $$
    //      ...
    //      $$
    //   B) 整个块压在同一独立行：
    //      $$...$$
    // 同时保持“定界符所在行必须独立”，避免把 `$10`、代码字符串或表格内容误吞成跨段公式。
    processed = processed.replace(/(^|\n)([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });
    processed = processed.replace(/(^|\n)([ \t]*)\$\$([^\n]*?\S[^\n]*?)\$\$[ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });

    // 2. 保护 \[...\] (display math) - 支持多行
    processed = processed.replace(/(^|\n)([ \t]*)\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\][ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });

    // 3. 保护 \(...\) (inline math)
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (match) => {
        return createLatexPlaceholder(match);
    });

    // 4. 保护安全的 $...$ (inline math)。
    // 为避免 KaTeX auto-render 的单美元误触发，这里把安全单美元公式转换为 \( ... \) 形式交给后处理渲染。
    // 闭合的 $x$、$n$、$abc$ 与 $O(L^2) \to O(1)$ 会渲染；
    // 不闭合的 $10、$PATH、模板 ${value}、表格跨列 $...|...$ 不会触发。
    // 行内公式内部允许出现转义美元 \$，并且不安全价格候选不会吞掉后续真实公式。
    processed = protectInlineDollarMath(processed);

    // 如果安全单美元公式原本是缩进独立行，Markdown 会把它当作缩进代码块。
    // 这里仅对“整行只有 LaTeX 占位符”的行去缩进，不影响列表项、引用块或普通缩进文本。
    processed = processed.replace(/(^|\n)[ \t]{4,}(%%LATEX_BLOCK_\d+%%)(?=[ \t]*(?:\n|$))/g, (match, linePrefix, placeholder) => {
        return `${linePrefix}${placeholder}`;
    });

    // 🟢 恢复代码围栏（占位符 → 原始代码块）
    for (const [placeholder, original] of codeFenceMap.entries()) {
        processed = processed.split(placeholder).join(original);
    }

    return { text: processed, map };
}

/**
 * 在 marked 解析后恢复被保护的 LaTeX 块。
 * @param {string} html marked 解析后的 HTML
 * @param {Map<string, string>} map 占位符到原始 LaTeX 的映射
 * @returns {string} 恢复后的 HTML
 */
function restoreLatexBlocks(html, map) {
    if (!map || map.size === 0 || typeof html !== 'string') return html;

    // P1-5：单遍恢复 LaTeX 占位符，避免公式数量较多时按占位符多次全 HTML 扫描。
    return html.replace(/%%LATEX_BLOCK_(\d+)%%/g, (placeholder) => {
        return map.get(placeholder) ?? placeholder;
    });
}

export { protectLatexBlocks, restoreLatexBlocks };
