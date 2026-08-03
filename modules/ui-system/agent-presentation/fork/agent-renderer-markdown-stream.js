function findUnclosedCodeFence(text) {
    if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) return null;
    const normalizedText = text.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    let activeFence = null;
    let offset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
        if (match) {
            const marker = match[1];
            const trailingText = match[2] || '';
            if (!activeFence) {
                activeFence = {
                    char: marker[0],
                    length: marker.length,
                    startOffset: offset,
                    contentOffset: offset + line.length + (lineIndex < lines.length - 1 ? 1 : 0),
                    language: (trailingText.trim().split(/\s+/)[0] || '').replace(/[^\w#+.-]/g, ''),
                };
            } else if (marker[0] === activeFence.char
                && marker.length >= activeFence.length
                && trailingText.trim() === '') {
                activeFence = null;
            }
        }
        offset += line.length + (lineIndex < lines.length - 1 ? 1 : 0);
    }
    if (!activeFence) return null;
    return {
        prefix: normalizedText.slice(0, activeFence.startOffset),
        code: normalizedText.slice(activeFence.contentOffset),
        language: activeFence.language,
    };
}

function findUnclosedToolRequest(text, options) {
    const marker = options.startMarker;
    if (typeof text !== 'string' || !text.includes(marker)) return null;
    let cursor = 0;
    while (cursor < text.length) {
        const startIndex = text.indexOf(marker, cursor);
        if (startIndex === -1) return null;
        if (options.isWrapped(text, startIndex, marker)) {
            cursor = startIndex + marker.length;
            continue;
        }
        const endIndex = options.findEnd(text, startIndex + marker.length);
        if (endIndex === -1) return { prefix: text.slice(0, startIndex), request: text.slice(startIndex) };
        cursor = endIndex;
    }
    return null;
}

function createAgentRendererMarkdownStream(options) {
    function parse(text) {
        const marked = options.getMarked();
        if (!marked) return options.escapeHtml(text);
        const processedText = options.preprocessTail(text);
        const unclosedTool = findUnclosedToolRequest(processedText, {
            startMarker: options.toolStartMarker,
            isWrapped: options.isWrappedMarker,
            findEnd: options.findToolEnd,
        });
        if (unclosedTool) {
            const prefixHtml = unclosedTool.prefix ? marked.parse(unclosedTool.prefix) : '';
            return `${prefixHtml}<pre class="vcp-stream-tool-request-sealed">${options.escapeHtml(unclosedTool.request)}</pre>`;
        }
        const unclosedFence = findUnclosedCodeFence(processedText);
        if (!unclosedFence) return marked.parse(processedText);
        const prefixHtml = unclosedFence.prefix ? marked.parse(unclosedFence.prefix) : '';
        const languageClass = unclosedFence.language
            ? ` language-${options.escapeHtml(unclosedFence.language)}` : '';
        const codeLines = unclosedFence.code.replace(/\r\n?/g, '\n').split('\n');
        const completedLineCount = Math.max(0, codeLines.length - 1);
        const lineHtml = codeLines.map((lineText, lineIndex) => {
            const escapedLine = lineText ? options.escapeHtml(lineText) : '&#8203;';
            const completed = lineIndex < completedLineCount
                ? ' data-vcp-stream-code-completed="true"' : '';
            return `<span class="vcp-stream-code-line" data-vcp-key="stream-code-line-${lineIndex}" data-vcp-stream-code-line="${lineIndex}"${completed}>${escapedLine}</span>`;
        }).join('');
        return `${prefixHtml}<pre class="vcp-stream-code-block"><code class="vcp-stream-code-lines${languageClass}">${lineHtml}</code></pre>`;
    }
    return { parse };
}

export { createAgentRendererMarkdownStream, findUnclosedCodeFence, findUnclosedToolRequest };
