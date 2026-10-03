/** Presentation only: retain protocol nodes and exact result-delete metadata.
 * Old text transcripts have no reliable call IDs. Never pair requests/results
 * by name, or report protocol block counts as completed operation counts.
 */
const BLOCKS = '[data-vcp-block-type="tool-use"], [data-vcp-block-type="jev-tool-use"], [data-vcp-block-type="tool-result"], [data-vcp-block-type="tool-call-summary"]';
const LABELS = { success: '成功', failed: '失败', running: '执行中', waiting: '待确认', stopped: '已停止', unknown: '状态未知', request: '请求', summary: '摘要' };
const COMMAND_LABELS = {GetCode:'读取源码', EditCode:'修改代码', CreateFile:'创建文件', ReadFile:'读取文件', UpdateTodos:'更新待办', ExecutePowerShell:'执行 PowerShell 命令', ListWorkspaces:'列出工作区', get_page_info:'读取页面信息'};
export function toolStatus(value) {
    const status = String(value || '').trim().replace(/^[✅❌⚠️\s]+/u, '').toLowerCase();
    if (['success', 'succeeded', '成功'].includes(status)) return 'success';
    if (['failed', 'failure', 'error', '失败', '错误'].includes(status)) return 'failed';
    if (['running', 'in_progress', '执行中'].includes(status)) return 'running';
    if (['pendingapproval', 'pending_approval', '待确认'].includes(status)) return 'waiting';
    if (['stopped', 'cancelled', 'canceled', '已停止', '已取消'].includes(status)) return 'stopped';
    return 'unknown';
}
function hash(value) {
    let n = 2166136261;
    for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
    return (n >>> 0).toString(36);
}
function readText(block) {
    return block.querySelector('template')?.content.textContent || block.textContent || '';
}
function requestSummary(block, originalName) {
    const raw = readText(block);
    // Only protocol fields at line starts; executable snippets are never parsed.
    const field = key => raw.match(new RegExp('(?:^|\\n)\\s*'+key+'\\s*:\\s*「始」([\\s\\S]*?)「末」', 'i'))?.[1]?.trim();
    const name = originalName || block.querySelector('.vcp-tool-name-highlight')?.textContent?.trim() || '工具';
    const command = field('command');
    const resource = field('path') || field('filePath');
    const knownAction = Object.hasOwn(COMMAND_LABELS, command) ? COMMAND_LABELS[command] : undefined;
    return { name, action: knownAction || (command ? `${name} · ${command.slice(0, 120)}` : name), resource: resource || (knownAction ? name : '') };
}
export function createToolPresentation({ root, getProfile }) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const roots = new WeakMap();
    const models = new WeakMap();
    const originalHeaders = new WeakMap();
    let disposed = false;
    let controlSequence = 0;
    const prefix = `vcp-tool-${hash(String(Date.now()) + String(Math.random()))}`;
    function profile(p = getProfile?.() || {}) {
        return { style: doc.documentElement.dataset.uiMode === 'next' && ['compact', 'grouped'].includes(p.toolPresentation) ? p.toolPresentation : 'legacy', expansion: p.toolExpansion || 'attention' };
    }
    function bucket(content) {
        const owner = content.closest('.message-item') || content;
        if (!roots.has(owner)) roots.set(owner, { items: new Map(), groups: new Map() });
        return roots.get(owner);
    }
    function capture(content) {
        const state = bucket(content);
        content.querySelectorAll('[data-vcp-tool-key]').forEach(block => {
            if (block.dataset.vcpToolTouched === 'true') state.items.set(block.dataset.vcpToolKey, block.classList.contains('expanded'));
        });
        content.querySelectorAll('.vcp-tool-process').forEach(group => {
            if (group.dataset.touched === 'true') state.groups.set(group.dataset.key, group.querySelector('.vcp-tool-process-toggle').getAttribute('aria-expanded') === 'true');
        });
    }
    function unwrap(content) {
        content.querySelectorAll('.vcp-tool-process').forEach(group => {
            const body = group.querySelector(':scope > .vcp-tool-process-body');
            if (body) group.replaceWith(...body.childNodes); else group.remove();
        });
    }
    function mountRequest(block, expanded) {
        if (!block.matches('.vcp-tool-use-bubble')) return;
        const body = block.querySelector(':scope > .vcp-tool-details');
        const template = block.querySelector(':scope > .vcp-tool-details-template');
        if (!body || !template) return; // JEV has its own details lifecycle.
        if (expanded && !body.childNodes.length) body.append(template.content.cloneNode(true));
        if (!expanded) body.replaceChildren();
    }
    function setItem(block, expanded, touched = false) {
        block.classList.toggle('expanded', expanded);
        block.querySelector('.vcp-tool-row-toggle')?.setAttribute('aria-expanded', String(expanded));
        mountRequest(block, expanded);
        if (touched) block.dataset.vcpToolTouched = 'true';
        const model = models.get(block);
        if (touched && model) bucket(model.content).items.set(model.key, expanded);
    }
    function decorate(block, content, p, occurrences) {
        const kind = block.dataset.vcpBlockType;
        const result = kind === 'tool-result';
        const summary = kind === 'tool-call-summary';
        const header = block.querySelector(result ? '.vcp-tool-result-header' : summary ? '.vcp-tool-call-summary-header' : '.vcp-tool-summary');
        if (!header) return null;
        if (!originalHeaders.has(block)) originalHeaders.set(block, { nodes: [...header.childNodes], header, expanded: block.classList.contains('expanded') });
        const original = originalHeaders.get(block);
        const extraActions = [...header.children].filter(node=>!node.matches('.vcp-tool-row-toggle, .vcp-tool-result-label, .vcp-tool-result-name, .vcp-tool-result-status, .vcp-result-toggle-icon, .vcp-tool-label, .vcp-tool-name-highlight, .vcp-tool-call-summary-icon, .vcp-tool-call-summary-title'));
        // File-change badges may be installed after the first render. Keep
        // their actual nodes and handlers through future appearance previews.
        original.extraActions = extraActions;
        const name = original.nodes.find(n => n.matches?.(result ? '.vcp-tool-result-name' : '.vcp-tool-name-highlight'))?.textContent?.trim() || (summary ? '调用摘要' : '工具');
        const status = result ? toolStatus(original.nodes.find(n => n.matches?.('.vcp-tool-result-status'))?.textContent) : summary ? 'summary' : 'request';
        const fingerprint = models.get(block)?.fingerprint || (result ? block.dataset.vcpToolResultHash || hash(readText(block)) : hash(readText(block)));
        const baseKey = `${kind}:${fingerprint}`;
        const occurrence = occurrences.get(baseKey) || 0;
        occurrences.set(baseKey, occurrence + 1);
        const key = `${baseKey}:${occurrence}`;
        const state = bucket(content);
        const model = { content, key, kind, status, name, block, fingerprint };
        models.set(block, model);
        block.dataset.vcpToolKey = key;
        block.dataset.vcpToolState = status;
        block.classList.add('vcp-tool-presented');
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'vcp-tool-row-toggle';
        const chevron = doc.createElement('span');
        chevron.className = 'vcp-tool-row-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        const title = doc.createElement('span');
        title.className = 'vcp-tool-row-title';
        const request = !result && !summary ? requestSummary(block, name) : null;
        title.textContent = result ? `${name} · 结果` : summary ? '调用摘要（原始记录）' : `${request.action} · 请求`;
        const resource = doc.createElement('span');
        resource.className = 'vcp-tool-row-resource';
        resource.textContent = request?.resource?.slice(0, 180) || '';
        const stateLabel = doc.createElement('span');
        stateLabel.className = 'vcp-tool-row-state';
        stateLabel.textContent = LABELS[status];
        btn.append(chevron, title, resource, stateLabel);
        header.replaceChildren(btn);
        // Keep the real delete button, outside the disclosure button.
        original.extraActions.forEach(n => header.append(n));
        if (summary && !block.querySelector('.vcp-tool-call-summary-content')) {
            const wrapper = doc.createElement('div');
            wrapper.className = 'vcp-tool-call-summary-content';
            [...block.childNodes].filter(node=>node!==header).forEach(node=>wrapper.append(node));
            block.append(wrapper);
        }
        const body = block.querySelector(result ? '.vcp-tool-result-collapsible-content' : summary ? '.vcp-tool-call-summary-content' : '.vcp-tool-details');
        if (body) {
            body.id ||= `${prefix}-${++controlSequence}`;
            btn.setAttribute('aria-controls', body.id);
        }
        const hasRichContent = !!block.querySelector('.vcp-tool-result-image, img, audio, video, iframe, .message-attachments');
        model.rich = hasRichContent;
        let expanded = state.items.has(key) ? state.items.get(key) : p.expansion === 'all' || p.expansion === 'attention' && ['failed', 'waiting'].includes(status);
        if (hasRichContent && p.expansion !== 'none' && !state.items.has(key)) expanded = true;
        setItem(block, expanded);
        if (state.items.has(key)) block.dataset.vcpToolTouched = 'true';
        return model;
    }
    function restore(block) {
        const original = originalHeaders.get(block);
        if (!original) return;
        original.header.replaceChildren(...original.nodes);
        original.extraActions?.filter(node=>!original.nodes.includes(node)).forEach(node=>original.header.append(node));
        const body = block.querySelector('.vcp-tool-result-collapsible-content, .vcp-tool-call-summary-content, .vcp-tool-details');
        if (body?.id?.startsWith(prefix)) body.removeAttribute('id');
        block.classList.remove('vcp-tool-presented');
        const summary = block.querySelector(':scope > .vcp-tool-call-summary-content');
        if (summary) summary.replaceWith(...summary.childNodes);
        delete block.dataset.vcpToolState;
        delete block.dataset.vcpToolKey;
        delete block.dataset.vcpToolTouched;
        setItem(block, original.expanded);
        originalHeaders.delete(block);
        models.delete(block);
    }
    function makeGroup(parent, members, content, p) {
        if (!members.length) return;
        const state = bucket(content);
        const items = members.map(node => models.get(node)).filter(Boolean);
        if (!items.length) return;
        const key = items[0].key;
        const counts = new Map();
        for (const m of items) counts.set(m.kind, (counts.get(m.kind) || 0) + 1);
        const stats = ['failed','waiting','running','stopped','unknown','success'].filter(s=>items.some(m=>m.status===s)).map(s=>`${items.filter(m=>m.status===s).length} ${LABELS[s]}`);
        const group = doc.createElement('section');
        group.className = 'vcp-tool-process';
        group.dataset.vcpBlockType = 'tool-process'; // Context extraction removes presentation labels too.
        group.dataset.key = key;
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = 'vcp-tool-process-toggle';
        const title = doc.createElement('span');
        title.className = 'vcp-tool-process-title';
        title.textContent = `工具过程 · ${counts.get('tool-use') || counts.get('jev-tool-use') ? (counts.get('tool-use') || 0)+(counts.get('jev-tool-use') || 0)+' 请求' : ''}${counts.get('tool-result') ? ' '+counts.get('tool-result')+' 结果' : ''}`.trim();
        if (![...counts.keys()].some(k=>k!=='tool-call-summary')) title.textContent = '工具调用摘要';
        if (items.filter(m=>m.kind!=='tool-call-summary').length === 1) {
            const item = items.find(m=>m.kind!=='tool-call-summary');
            title.textContent = item.kind === 'tool-result' ? `${item.name} · 1 结果` : `${requestSummary(item.block,item.name).action} · 1 请求`;
        }
        const badge = doc.createElement('span');
        badge.className = 'vcp-tool-process-stats';
        badge.textContent = stats.join(' · ') || '可展开查看';
        const arrow = doc.createElement('span');
        arrow.className = 'vcp-tool-row-chevron';
        arrow.setAttribute('aria-hidden','true');
        toggle.append(arrow, title, badge);
        const body = doc.createElement('div');
        body.className = 'vcp-tool-process-body';
        body.id = `${prefix}-${++controlSequence}`;
        toggle.setAttribute('aria-controls', body.id);
        const expanded = state.groups.has(key) ? state.groups.get(key) : p.expansion === 'all' || p.expansion === 'attention' && items.some(m=>['failed','waiting','running'].includes(m.status)||m.rich);
        toggle.setAttribute('aria-expanded', String(expanded));
        body.hidden = !expanded;
        group.append(toggle, body);
        parent.insertBefore(group, members[0]);
        members.forEach(node=>body.append(node));
        if (items.some(m=>m.rich)) {
            const artifact = doc.createElement('button');
            artifact.type = 'button';
            artifact.className = 'vcp-tool-process-artifact';
            artifact.textContent = '图片 / 媒体结果 · 查看';
            group.append(artifact);
        }
        if (state.groups.has(key)) group.dataset.touched = 'true';
    }
    function apply(content, incomingProfile) {
        if (disposed || !content) return;
        capture(content);
        unwrap(content);
        const p = profile(incomingProfile);
        content.dataset.vcpToolPresentation = p.style;
        const blocks = [...content.querySelectorAll(BLOCKS)];
        if (p.style === 'legacy') { blocks.forEach(restore); return; }
        const occurrences = new Map();
        const owner = content.closest('.message-item');
        if (owner && blocks.length) {
            for (const prior of owner.querySelectorAll(BLOCKS)) {
                if (prior === blocks[0]) break;
                const fingerprint = models.get(prior)?.fingerprint || prior.dataset.vcpToolResultHash || hash(readText(prior));
                const key = `${prior.dataset.vcpBlockType}:${fingerprint}`;
                occurrences.set(key, (occurrences.get(key) || 0) + 1);
            }
        }
        blocks.forEach(block=>decorate(block, content, p, occurrences));
        if (p.style !== 'grouped') return;
        for (const parent of new Set(blocks.map(n=>n.parentElement))) {
            let members = [];
            const flush = ()=>{makeGroup(parent, members, content, p);members=[];};
            for (const node of [...parent.childNodes]) {
                if (models.has(node)) members.push(node);
                else if (node.nodeType === 3 && !node.textContent.trim()) { if (members.length) members.push(node); }
                else if (node.nodeType === 1 && (node.tagName === 'BR' || node.tagName === 'P' && !node.textContent.trim() && !node.children.length)) { if(members.length)members.push(node); }
                else flush(); // Text, role boundaries, widgets and other content end a group.
            }
            flush();
        }
    }
    function changeGroup(group, expanded, touched = true) {
        group.querySelector('.vcp-tool-process-toggle').setAttribute('aria-expanded', String(expanded));
        group.querySelector('.vcp-tool-process-body').hidden = !expanded;
        if (touched) {
            group.dataset.touched = 'true';
            const content = group.closest('[data-vcp-tool-presentation]');
            bucket(content).groups.set(group.dataset.key, expanded);
        }
    }
    function onClick(event) {
        const btn = event.target.closest?.('.vcp-tool-row-toggle, .vcp-tool-process-toggle, .vcp-tool-process-artifact');
        if (!btn || !root.contains(btn)) return;
        event.preventDefault();
        event.stopPropagation(); // The legacy delegated header must not toggle twice.
        if (btn.classList.contains('vcp-tool-row-toggle')) {
            const block = btn.closest('[data-vcp-tool-key]');
            setItem(block, !block.classList.contains('expanded'), true);
        } else {
            const group = btn.closest('.vcp-tool-process');
            if (btn.classList.contains('vcp-tool-process-artifact')) {
                changeGroup(group, true);
                group.querySelectorAll('[data-vcp-tool-key]').forEach(block=>{if(models.get(block)?.rich)setItem(block,true,true);});
            } else changeGroup(group, btn.getAttribute('aria-expanded') !== 'true');
        }
    }
    function refresh(event) {
        if (disposed) return;
        // Appearance publishes its event before updating getCurrent(). Use the
        // authoritative event payload so preview/cancel never lags a click.
        root.querySelectorAll('.md-content').forEach(content=>apply(content,event?.detail?.profile));
    }
    root.addEventListener('click', onClick, true);
    win.addEventListener('vcp-appearance-changed', refresh);
    return { apply, capture, dispose() {disposed=true;root.removeEventListener('click',onClick,true);win.removeEventListener('vcp-appearance-changed',refresh);} };
}
