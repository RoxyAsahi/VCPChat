export function createAgentRendererSpecialBlocks(deps) {
    const {
        getMarked, escapeHtml, replaceToolRequestBlocks, noteRegex, toolCallSummaryRegex,
        conventionalThoughtRegex, thoughtChainRegex, roleDividerRegex,
    } = deps;
    const agentRenderContext = { get markedInstance() { return getMarked(); } };
    const NOTE_REGEX = noteRegex;
    const TOOL_CALL_SUMMARY_REGEX = toolCallSummaryRegex;
    const CONVENTIONAL_THOUGHT_REGEX = conventionalThoughtRegex;
    const THOUGHT_CHAIN_REGEX = thoughtChainRegex;
    const ROLE_DIVIDER_REGEX = roleDividerRegex;

    function transformSpecialBlocks(text, codeBlockMap) {
        let processed = text;
    
        const restoreBlocks = (textStr) => {
            if (!textStr || !codeBlockMap) return textStr;
            let res = textStr;
            for (const [placeholder, block] of codeBlockMap.entries()) {
                if (res.includes(placeholder)) {
                    res = res.replace(placeholder, () => block);
                }
            }
            return res;
        };
    
        // 🟢 架构级修复：VCP Tool Results 不再在此处理
        // 工具结果块在 contentPipeline 中被提取为占位符，贯穿 Markdown 解析后
        // 由 restoreRenderedToolResults() 独立渲染并恢复，彻底避免内部语法干扰
    
        const createVcpEndMarkerRegex = (isEscape) => {
            return isEscape
                ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi
                : /[「{]末[」}]/g;
        };
    
        const extractMarkedField = (source, labelRegex) => {
            if (!source || typeof source !== 'string') return null;
    
            const labelMatch = labelRegex.exec(source);
            if (!labelMatch) return null;
    
            const startRegex = /[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi;
            startRegex.lastIndex = labelMatch.index + labelMatch[0].length;
            const startMatch = startRegex.exec(source);
            if (!startMatch) return null;
    
            // 字段名和起始标记之间只允许空白，避免误吞到后续字段
            if (source.slice(labelMatch.index + labelMatch[0].length, startMatch.index).trim() !== '') {
                return null;
            }
    
            const startMarker = startMatch[0];
            const isEscape = /escape/i.test(startMarker);
            const contentStart = startMatch.index + startMarker.length;
            const endRegex = createVcpEndMarkerRegex(isEscape);
            endRegex.lastIndex = contentStart;
            const endMatch = endRegex.exec(source);
    
            if (!endMatch) {
                return source.slice(contentStart).trim();
            }
    
            return source.slice(contentStart, endMatch.index).trim();
        };
    
        const renderMarkdownField = (rawText) => {
            const restoredText = restoreBlocks(rawText || '');
            if (agentRenderContext.markedInstance) {
                try {
                    return agentRenderContext.markedInstance.parse(restoredText);
                } catch (e) {
                    return escapeHtml(restoredText);
                }
            }
            return escapeHtml(restoredText);
        };
    
        const getDailyNoteAgentInfo = (source) => {
            const maid = extractMarkedField(source, /(?:maid|maidName):\s*/i) || '';
            const valet = extractMarkedField(source, /(?:valet|valetName):\s*/i) || '';
    
            if (valet) {
                return {
                    name: valet,
                    type: 'valet',
                    gender: 'male',
                    label: 'Valet',
                    title: "Valet's Diary"
                };
            }
    
            return {
                name: maid,
                type: 'maid',
                gender: 'female',
                label: 'Maid',
                title: "Maid's Diary"
            };
        };
    
        const renderDailyNoteCreate = ({ agentName, agentType = 'maid', agentGender = 'female', agentLabel = 'Maid', defaultTitle = "Maid's Diary", date, fileName, folder, diaryContent, diaryTag }) => {
            let html = `<div class="maid-diary-bubble ${agentType}-diary-bubble" data-vcp-block-type="maid-diary" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
            html += `<div class="diary-header">`;
            html += `<span class="diary-title">${fileName ? escapeHtml(fileName) : escapeHtml(defaultTitle)}</span>`;
            if (date) {
                html += `<span class="diary-date">${escapeHtml(date)}</span>`;
            }
            html += `</div>`;
    
            if (agentName || folder) {
                html += `<div class="diary-maid-info">`;
                if (agentName) {
                    html += `<span class="diary-maid-label">${escapeHtml(agentLabel)}:</span> `;
                    html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
                }
                if (folder) {
                    if (agentName) html += ` <span class="diary-meta-separator">·</span> `;
                    html += `<span class="diary-folder-label">Folder:</span> `;
                    html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
                }
                html += `</div>`;
            }
    
            let diaryBody = diaryContent || '[日记内容解析失败]';
            if (diaryTag) {
                diaryBody += `\n\nTag:${diaryTag}`;
            }
    
            html += `<div class="diary-content">${renderMarkdownField(diaryBody)}</div>`;
            html += `</div>`;
    
            return `\n\n${html}\n\n`;
        };
    
        const renderDailyNoteUpdate = ({ agentName, agentType = 'maid', agentGender = 'female', folder, target, replace }) => {
            const hasTarget = target && target.trim();
            const hasReplace = replace && replace.trim();
    
            let html = `<div class="maid-diary-update-bubble ${agentType}-diary-update-bubble" data-vcp-block-type="maid-diary-update" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
            html += `<div class="diary-update-header">`;
            html += `<span class="diary-update-title">DailyNote Update</span>`;
            if (agentName || folder) {
                html += `<span class="diary-update-meta">`;
                if (agentName) html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
                if (agentName && folder) html += ` <span class="diary-meta-separator">·</span> `;
                if (folder) html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
                html += `</span>`;
            }
            html += `</div>`;
    
            html += `<div class="diary-update-body">`;
            html += `<div class="diary-update-side diary-update-before">`;
            html += `<div class="diary-update-label">A</div>`;
            html += `<div class="diary-update-content">${hasTarget ? renderMarkdownField(target) : '<em>原文解析失败</em>'}</div>`;
            html += `</div>`;
            html += `<div class="diary-update-arrow" aria-hidden="true">→</div>`;
            html += `<div class="diary-update-side diary-update-after">`;
            html += `<div class="diary-update-label">B</div>`;
            html += `<div class="diary-update-content">${hasReplace ? renderMarkdownField(replace) : '<em>替换内容解析失败</em>'}</div>`;
            html += `</div>`;
            html += `</div>`;
            html += `</div>`;
    
            return `\n\n${html}\n\n`;
        };
    
        // Process Tool Call Summaries
        const renderToolCallSummaryBlock = (rawContent) => {
            const content = restoreBlocks(rawContent || '').trim();
            const entries = content
                .split(/[；;。]\s*/u)
                .map(item => item.trim())
                .filter(Boolean);
    
            const getStatusInfo = (entry) => {
                if (/拒绝|被拒|denied|rejected|refused/i.test(entry)) {
                    return { key: 'rejected', label: '拒绝' };
                }
                if (/失败|错误|异常|error|failed/i.test(entry)) {
                    return { key: 'failure', label: '失败' };
                }
                if (/超时|timeout/i.test(entry)) {
                    return { key: 'timeout', label: '超时' };
                }
                if (/成功|完成|success|succeeded|ok/i.test(entry)) {
                    return { key: 'success', label: '成功' };
                }
                if (/取消|中止|cancel/i.test(entry)) {
                    return { key: 'cancelled', label: '取消' };
                }
                if (/跳过|skip/i.test(entry)) {
                    return { key: 'skipped', label: '跳过' };
                }
                return { key: 'unknown', label: '未知' };
            };
    
            const renderEntry = (entry) => {
                const statusInfo = getStatusInfo(entry);
                const toolNameMatch = entry.match(/^(.+?)\s*调用/u);
                const toolName = (toolNameMatch?.[1] || entry.replace(/调用.*/u, '') || 'Tool').trim();
                return `<span class="vcp-tool-call-summary-chip status-${statusInfo.key}">` +
                    `<span class="vcp-tool-call-summary-tool">${escapeHtml(toolName)}</span>` +
                    `<span class="vcp-tool-call-summary-status">${escapeHtml(statusInfo.label)}</span>` +
                    `</span>`;
            };
    
            let html = `<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary" data-vcp-preserve-children="true">`;
            html += `<div class="vcp-tool-call-summary-header">`;
            html += `<span class="vcp-tool-call-summary-icon">🧾</span>`;
            html += `<span class="vcp-tool-call-summary-title">本轮工具调用摘要</span>`;
            html += `</div>`;
    
            if (entries.length > 0) {
                html += `<div class="vcp-tool-call-summary-list">${entries.map(renderEntry).join('')}</div>`;
            } else {
                html += `<div class="vcp-tool-call-summary-raw">${escapeHtml(content || '无摘要内容')}</div>`;
            }
    
            html += `</div>`;
            return `\n\n${html}\n\n`;
        };
    
        const transformToolCallSummariesInRoleSections = (source) => {
            if (typeof source !== 'string' || !source.includes('[本轮工具调用摘要:]') || !source.includes('<<<[ROLE_DIVIDE_')) {
                return source;
            }
    
            let result = '';
            let cursor = 0;
            const roleStartRegex = /<<<\[ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
    
            while (cursor < source.length) {
                roleStartRegex.lastIndex = cursor;
                const startMatch = roleStartRegex.exec(source);
                if (!startMatch) {
                    result += source.slice(cursor);
                    break;
                }
    
                result += source.slice(cursor, startMatch.index);
    
                const role = startMatch[1];
                const endToken = `<<<[END_ROLE_DIVIDE_${role}]>>>`;
                const sectionContentStart = startMatch.index + startMatch[0].length;
                const endIndex = source.indexOf(endToken, sectionContentStart);
    
                if (endIndex === -1) {
                    result += source.slice(startMatch.index);
                    break;
                }
    
                const sectionContent = source.slice(sectionContentStart, endIndex);
                const transformedSectionContent = sectionContent.replace(TOOL_CALL_SUMMARY_REGEX, (match, rawContent) => {
                    return renderToolCallSummaryBlock(rawContent);
                });
                TOOL_CALL_SUMMARY_REGEX.lastIndex = 0;
    
                result += startMatch[0] + transformedSectionContent + endToken;
                cursor = endIndex + endToken.length;
            }
    
            return result;
        };
    
        processed = transformToolCallSummariesInRoleSections(processed);
    
        // Process Tool Requests
        processed = replaceToolRequestBlocks(processed, (match, content) => {
            const detectedToolName = extractMarkedField(content, /tool_name:\s*/i);
            const detectedCommand = extractMarkedField(content, /command:\s*/i);
            const normalizedToolName = (detectedToolName || '').trim().toLowerCase();
            const normalizedCommand = (detectedCommand || '').trim().toLowerCase();
    
            // DailyNote 新版 Tool Request:
            // 1) tool_name 为 DailyNote 且 command 为 update 时渲染为 A → B 替换预览；
            // 2) 如果没有 create/update 指令，但同时存在 target 和 replace 字段，也按 update 渲染；
            // 3) tool_name 为 DailyNote 且 command 为 create 时渲染为日记创建；
            // 4) 如果没有 create/update 指令，但存在 content 字段，也按 create 渲染。
            const dailyNoteContent = extractMarkedField(content, /Content:\s*/i);
            const dailyNoteTarget = extractMarkedField(content, /target:\s*/i);
            const dailyNoteReplace = extractMarkedField(content, /replace:\s*/i);
            const isDailyNoteTool = normalizedToolName === 'dailynote';
            const isDailyNoteUpdate = isDailyNoteTool && (normalizedCommand === 'update' || (!normalizedCommand && dailyNoteTarget && dailyNoteReplace));
            const isDailyNoteCreate = isDailyNoteTool && !isDailyNoteUpdate && (normalizedCommand === 'create' || (!normalizedCommand && dailyNoteContent));
    
            if (isDailyNoteCreate) {
                const dailyNoteAgent = getDailyNoteAgentInfo(content);
                return renderDailyNoteCreate({
                    agentName: dailyNoteAgent.name,
                    agentType: dailyNoteAgent.type,
                    agentGender: dailyNoteAgent.gender,
                    agentLabel: dailyNoteAgent.label,
                    defaultTitle: dailyNoteAgent.title,
                    date: extractMarkedField(content, /Date:\s*/i) || '',
                    fileName: extractMarkedField(content, /fileName:\s*/i) || '',
                    folder: extractMarkedField(content, /folder:\s*/i) || '',
                    diaryContent: dailyNoteContent || '[日记内容解析失败]',
                    diaryTag: extractMarkedField(content, /Tag:\s*/i) || ''
                });
            } else if (isDailyNoteUpdate) {
                const dailyNoteAgent = getDailyNoteAgentInfo(content);
                return renderDailyNoteUpdate({
                    agentName: dailyNoteAgent.name,
                    agentType: dailyNoteAgent.type,
                    agentGender: dailyNoteAgent.gender,
                    folder: extractMarkedField(content, /folder:\s*/i) || '',
                    target: dailyNoteTarget || '',
                    replace: dailyNoteReplace || ''
                });
            } else {
                // --- It's a regular tool call, render it normally ---
                const xmlToolNameMatch = content.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);
    
                let toolName = 'Processing...';
                let extractedName = (xmlToolNameMatch?.[1] || detectedToolName || '').trim();
                if (extractedName) {
                    extractedName = extractedName.replace(/[「{](?:始|末)(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi, '').replace(/,$/, '').trim();
                }
                if (extractedName) {
                    toolName = extractedName;
                }
    
                const escapedFullContent = escapeHtml(restoreBlocks(content));
                return `\n\n<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use" data-vcp-preserve-children="true">` +
                    `<div class="vcp-tool-summary">` +
                    `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                    `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
                    `</div>` +
                    `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
                    `</div>\n\n`;
            }
        });
    
        // Process Daily Notes
        processed = processed.replace(NOTE_REGEX, (match, rawContent) => {
            const content = rawContent.trim();
            const maidRegex = /Maid:\s*([^\n\r]*)/;
            const dateRegex = /Date:\s*([^\n\r]*)/;
            const contentRegex = /Content:\s*([\s\S]*)/;
    
            const maidMatch = content.match(maidRegex);
            const dateMatch = content.match(dateRegex);
            const contentMatch = content.match(contentRegex);
    
            const maid = maidMatch ? maidMatch[1].trim() : '';
            const date = dateMatch ? dateMatch[1].trim() : '';
            // The rest of the text after "Content:", or the full text if "Content:" is not found
            const diaryContent = contentMatch ? contentMatch[1].trim() : content;
    
            let html = `<div class="maid-diary-bubble" data-vcp-block-type="maid-diary" data-vcp-preserve-children="true">`;
            html += `<div class="diary-header">`;
            html += `<span class="diary-title">Maid's Diary</span>`;
            if (date) {
                html += `<span class="diary-date">${escapeHtml(date)}</span>`;
            }
            html += `</div>`;
    
            if (maid) {
                html += `<div class="diary-maid-info">`;
                html += `<span class="diary-maid-label">Maid:</span> `;
                html += `<span class="diary-maid-name">${escapeHtml(maid)}</span>`;
                html += `</div>`;
            }
    
            let processedDiaryContent;
            if (agentRenderContext.markedInstance) {
                try {
                    processedDiaryContent = agentRenderContext.markedInstance.parse(restoreBlocks(diaryContent));
                } catch (e) {
                    processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
                }
            } else {
                processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
            }
            html += `<div class="diary-content">${processedDiaryContent}</div>`;
            html += `</div>`;
    
            return `\n\n${html}\n\n`;
        });
    
        // Process VCP Thought Chains
        const renderThoughtChain = (theme, rawContent) => {
            const displayTheme = theme ? theme.trim() : "元思考链";
            const content = rawContent.trim();
            const escapedContent = escapeHtml(restoreBlocks(content));
    
            let html = `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain" data-vcp-preserve-children="true">`;
            html += `<div class="vcp-thought-chain-header">`;
            html += `<span class="vcp-thought-chain-icon">🧠</span>`;
            html += `<span class="vcp-thought-chain-label">${escapeHtml(displayTheme)}</span>`;
            html += `<span class="vcp-result-toggle-icon"></span>`;
            html += `</div>`;
    
            html += `<div class="vcp-thought-chain-collapsible-content">`;
    
            let processedContent;
            if (agentRenderContext.markedInstance) {
                try {
                    processedContent = agentRenderContext.markedInstance.parse(restoreBlocks(content));
                } catch (e) {
                    processedContent = `<pre>${escapedContent}</pre>`;
                }
            } else {
                processedContent = `<pre>${escapedContent}</pre>`;
            }
    
            html += `<div class="vcp-thought-chain-body">${processedContent}</div>`;
            html += `</div>`; // End of vcp-thought-chain-collapsible-content
            html += `</div>`; // End of vcp-thought-chain-bubble
    
            return `\n\n${html}\n\n`;
        };
    
        processed = processed.replace(THOUGHT_CHAIN_REGEX, (match, theme, rawContent) => {
            return renderThoughtChain(theme, rawContent);
        });
    
        // Process Conventional Thought Chains (<think>...</think> / <thinking>...</thinking>)
        processed = processed.replace(CONVENTIONAL_THOUGHT_REGEX, (match, tagName, rawContent) => {
            return renderThoughtChain("思维链", rawContent);
        });
    
        // Desktop Push blocks 已在 preprocessFullContent 中于代码块保护之后统一处理
        // 这里不再重复处理，避免与代码块内的语法冲突
    
        // Process Role Dividers
        processed = processed.replace(ROLE_DIVIDER_REGEX, (match, isEnd, role) => {
            const isEndMarker = !!isEnd;
            const roleLower = role.toLowerCase();
    
            let label = '';
            if (roleLower === 'system') label = 'System';
            else if (roleLower === 'assistant') label = 'Assistant';
            else if (roleLower === 'user') label = 'User';
    
            const actionText = isEndMarker ? '末' : '始';
    
            return `\n\n<div class="vcp-role-divider role-${roleLower} type-${isEndMarker ? 'end' : 'start'}" data-vcp-block-type="role-divider" data-vcp-preserve-children="true"><span class="divider-text">${label} 分界之${actionText}</span></div>\n\n`;
        });
    
        return processed;
    }
    
    /**
     * Transforms user's "clicked button" indicators into styled bubbles.
     * @param {string} text The text content.
     * @returns {string} The processed text.
     */

    return { transformSpecialBlocks };
}
