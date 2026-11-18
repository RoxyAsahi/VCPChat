// WorkflowEditor Run Panel
// 底部运行面板：一次运行里每个节点的状态、耗时、输出与错误，点击定位到画布节点。
(function () {
    'use strict';

    const STATUS_TEXT = {
        pending: '等待',
        notrun: '未执行',
        running: '运行中',
        retrying: '重试中',
        success: '完成',
        error: '失败',
        skipped: '跳过'
    };

    const RUN_TEXT = {
        idle: '未运行',
        running: '运行中',
        success: '运行成功',
        error: '运行失败',
        stopped: '已停止'
    };

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDuration(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
        if (ms < 1000) return `${Math.round(ms)}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const m = Math.floor(ms / 60000);
        const s = Math.round((ms % 60000) / 1000);
        return `${m}m${String(s).padStart(2, '0')}s`;
    }

    // 把节点结果压成可读文本：优先取常见的文本字段，其次整体 JSON
    const TEXT_KEYS = ['text', 'content', 'output', 'result', 'message', 'data'];

    // 在常见包装（{status, result: {content}} 等）里找第一段正文，最多下探三层
    function findText(value, depth) {
        if (typeof value === 'string') return value.trim() ? value : null;
        if (!value || typeof value !== 'object' || depth > 3 || Array.isArray(value)) return null;
        for (const key of TEXT_KEYS) {
            if (key in value) {
                const found = findText(value[key], depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    function resultToText(result) {
        if (result === undefined || result === null) return '';
        if (typeof result === 'string') return result;
        const found = findText(result, 0);
        if (found) return found;
        try {
            return JSON.stringify(result, null, 2);
        } catch (_) {
            return String(result);
        }
    }

    function findImageUrl(result) {
        const text = typeof result === 'string' ? result : (() => {
            try { return JSON.stringify(result); } catch (_) { return ''; }
        })();
        const match = text && text.match(/(https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp))(?=[\s"'<>]|$)|(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{32,})/i);
        return match ? (match[1] || match[2]) : null;
    }

    function previewLine(text, max = 80) {
        const one = String(text || '').replace(/\s+/g, ' ').trim();
        return one.length > max ? one.slice(0, max) + '…' : one;
    }

    class WorkflowEditor_RunPanel {
        constructor() {
            if (WorkflowEditor_RunPanel.instance) {
                return WorkflowEditor_RunPanel.instance;
            }
            this.stateManager = null;
            this.root = null;
            this.expanded = false;
            this.selectedNodeId = null;
            this.timer = null;
            this.resetRun();
            WorkflowEditor_RunPanel.instance = this;
        }

        resetRun() {
            this.run = {
                status: 'idle',
                startedAt: null,
                finishedAt: null,
                error: null,
                steps: new Map() // nodeId -> step
            };
        }

        init(stateManager, mountPoint) {
            this.stateManager = stateManager;
            this.mount(mountPoint);
            if (this._bound) return;
            this._bound = true;
            stateManager.on('executionStarted', (e) => this.onStarted(e));
            stateManager.on('executionNodeStatus', (e) => this.onNodeStatus(e));
            stateManager.on('executionFinished', (e) => this.onFinished(e));
            stateManager.on('nodeRemoved', (data) => {
                const id = data && (data.nodeId || data.id);
                if (id && this.run.steps.delete(id)) this.render();
            });
        }

        mount(mountPoint) {
            if (!mountPoint) return;
            this.root = mountPoint;
            this.root.classList.add('wf-run-panel');
            this.root.addEventListener('click', (e) => this.handleClick(e));
            this.render();
        }

        setExpanded(expanded) {
            this.expanded = !!expanded;
            this.render();
        }

        toggle() {
            this.setExpanded(!this.expanded);
        }

        // ---- 执行事件 ----

        onStarted(e) {
            this.resetRun();
            this.run.status = 'running';
            this.run.startedAt = e.at;
            this.selectedNodeId = null;
            // 预先列出全部节点（等待态），运行中按开始顺序重排
            const nodes = this.stateManager.getAllNodes();
            const order = typeof this.stateManager.getExecutionOrder === 'function'
                ? (this.stateManager.getExecutionOrder() || []) : [];
            const rank = new Map(order.map((id, i) => [id, i]));
            nodes
                .slice()
                .sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9))
                .forEach((node, index) => {
                    this.run.steps.set(node.id, {
                        nodeId: node.id,
                        name: node.name || node.pluginId || node.id,
                        pluginId: node.pluginId || node.type || '',
                        status: 'pending',
                        order: 1e6 + index,
                        startedAt: null,
                        finishedAt: null,
                        result: undefined,
                        error: null,
                        attempts: 0
                    });
                });
            document.querySelectorAll('.canvas-node .wf-run-badge').forEach(el => el.remove());
            this.expanded = true;
            this.startTicker();
            this.render();
        }

        onNodeStatus(e) {
            let step = this.run.steps.get(e.nodeId);
            if (!step) {
                const node = this.stateManager.getNode(e.nodeId) || {};
                step = {
                    nodeId: e.nodeId,
                    name: node.name || e.nodeId,
                    pluginId: node.pluginId || '',
                    status: 'pending',
                    order: 1e6 + this.run.steps.size,
                    startedAt: null, finishedAt: null, result: undefined, error: null, attempts: 0
                };
                this.run.steps.set(e.nodeId, step);
            }
            const status = e.status === 'executing' ? 'running' : e.status;
            if (status === 'running') {
                if (!step.startedAt || step.finishedAt) {
                    step.startedAt = e.at;
                    step.finishedAt = null;
                    step.order = this.nextOrder();
                }
                step.attempts += 1;
            } else if (status === 'retrying') {
                // 保留开始时间，耗时包含重试
            } else if (status === 'success' || status === 'error' || status === 'skipped') {
                step.finishedAt = e.at;
                if (status === 'skipped') step.order = this.nextOrder();
            }
            step.status = status;
            if (status === 'success') {
                step.result = e.result;
                step.error = null;
            }
            if (status === 'error') {
                step.error = e.error || '节点执行失败';
                if (!this.selectedNodeId) this.selectedNodeId = step.nodeId;
            }
            this.updateNodeBadge(step);
            this.render();
        }

        onFinished(e) {
            this.run.finishedAt = e.at;
            this.run.error = e.error || null;
            this.run.status = e.stopped ? 'stopped' : (e.ok ? 'success' : 'error');
            this.run.steps.forEach(step => {
                if (step.status === 'pending') step.status = 'notrun';
            });
            // 预检失败等没有任何节点开始的情况，把原因放进面板
            this.stopTicker();
            if (!e.ok) this.expanded = true;
            this.render();
        }

        nextOrder() {
            this._orderSeq = (this._orderSeq || 0) + 1;
            return this._orderSeq;
        }

        startTicker() {
            this.stopTicker();
            this.timer = setInterval(() => {
                if (this.run.status === 'running') this.renderHeader();
            }, 250);
        }

        stopTicker() {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
        }

        // ---- 画布节点徽标 ----

        updateNodeBadge(step) {
            const el = document.getElementById(step.nodeId);
            if (!el) return;
            const header = el.querySelector('.canvas-node-header');
            if (!header) return;
            let badge = header.querySelector('.wf-run-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'wf-run-badge';
                const statusDot = header.querySelector('.canvas-node-status');
                header.insertBefore(badge, statusDot || null);
            }
            badge.dataset.status = step.status;
            if (step.status === 'success') {
                badge.textContent = formatDuration(step.finishedAt - step.startedAt);
            } else if (step.status === 'error') {
                badge.textContent = '失败';
            } else if (step.status === 'skipped') {
                badge.textContent = '跳过';
            } else if (step.status === 'retrying') {
                badge.textContent = `重试 ${step.attempts}`;
            } else {
                badge.textContent = '…';
            }
            badge.title = step.error || STATUS_TEXT[step.status] || '';
        }

        // ---- 交互 ----

        handleClick(e) {
            const toggle = e.target.closest('[data-run-action="toggle"]');
            if (toggle) {
                this.toggle();
                return;
            }
            const copy = e.target.closest('[data-run-action="copy"]');
            if (copy) {
                const step = this.run.steps.get(this.shownStepId);
                const text = step ? (step.error || resultToText(step.result)) : '';
                if (text && navigator.clipboard) {
                    navigator.clipboard.writeText(text).then(() => {
                        copy.textContent = '已复制';
                        setTimeout(() => { copy.textContent = '复制'; }, 1200);
                    }).catch(() => {});
                }
                return;
            }
            const row = e.target.closest('[data-step-id]');
            if (row) {
                this.selectStep(row.dataset.stepId);
            }
        }

        selectStep(nodeId) {
            this.selectedNodeId = nodeId;
            this.render();
            if (this.stateManager.getNode(nodeId)) {
                this.stateManager.selectNode(nodeId);
                const ui = window.WorkflowEditor_UIManager;
                if (ui && typeof ui.centerOnNode === 'function') ui.centerOnNode(nodeId);
            }
        }

        // ---- 渲染 ----

        orderedSteps() {
            return Array.from(this.run.steps.values()).sort((a, b) => a.order - b.order);
        }

        counts() {
            const c = { total: 0, success: 0, error: 0, skipped: 0, running: 0 };
            this.run.steps.forEach(s => {
                c.total += 1;
                if (s.status === 'success') c.success += 1;
                else if (s.status === 'error') c.error += 1;
                else if (s.status === 'skipped') c.skipped += 1;
                else if (s.status === 'running' || s.status === 'retrying') c.running += 1;
            });
            return c;
        }

        elapsed() {
            if (!this.run.startedAt) return null;
            const end = this.run.finishedAt || Date.now();
            return end - this.run.startedAt;
        }

        render() {
            if (!this.root) return;
            this.root.classList.toggle('expanded', this.expanded);
            this.root.dataset.runStatus = this.run.status;
            this.root.innerHTML = `
                <div class="wf-run-header" data-run-action="toggle" role="button" tabindex="0"
                     aria-expanded="${this.expanded}" title="${this.expanded ? '收起运行面板' : '展开运行面板'}">
                    ${this.headerInner()}
                </div>
                ${this.expanded ? `<div class="wf-run-body">${this.bodyInner()}</div>` : ''}
            `;
        }

        renderHeader() {
            const header = this.root && this.root.querySelector('.wf-run-header');
            if (header) header.innerHTML = this.headerInner();
        }

        headerInner() {
            const c = this.counts();
            const status = this.run.status;
            const done = c.success + c.error + c.skipped;
            const figures = status === 'idle'
                ? '<span class="wf-run-hint">Ctrl+Enter 运行；每个节点的状态、耗时和输出会出现在这里</span>'
                : `
                    <span class="wf-run-fig" title="已结束 / 全部节点">${done}/${c.total} 节点</span>
                    ${c.error ? `<span class="wf-run-fig is-error">${c.error} 失败</span>` : ''}
                    ${c.skipped ? `<span class="wf-run-fig is-muted">${c.skipped} 跳过</span>` : ''}
                    <span class="wf-run-fig mono" title="总耗时">${formatDuration(this.elapsed())}</span>
                `;
            return `
                <span class="wf-run-light" data-status="${status}"></span>
                <span class="wf-run-title">运行记录</span>
                <span class="wf-run-state" data-status="${status}">${RUN_TEXT[status] || status}</span>
                ${figures}
                <span class="wf-run-chevron" aria-hidden="true">${this.expanded ? '▾' : '▴'}</span>
            `;
        }

        bodyInner() {
            const steps = this.orderedSteps();
            if (steps.length === 0) {
                const reason = this.run.error
                    ? `<div class="wf-run-error-block">${escapeHtml(this.run.error)}</div>`
                    : '<div class="wf-run-empty">还没有运行记录。搭好节点后点「运行」或按 Ctrl+Enter。</div>';
                return `<div class="wf-run-solo">${reason}</div>`;
            }
            // 没点选时默认看最后一个跑完的节点（通常就是这次运行的产出）
            const selected = this.run.steps.get(this.selectedNodeId)
                || steps.filter(s => s.status === 'success').pop()
                || null;
            const list = steps.map((s, i) => {
                const preview = s.status === 'error'
                    ? s.error
                    : (s.status === 'success' ? previewLine(resultToText(s.result)) : '');
                const dur = s.startedAt && s.finishedAt ? formatDuration(s.finishedAt - s.startedAt)
                    : (s.startedAt && (s.status === 'running' || s.status === 'retrying') ? '…' : '—');
                return `
                    <div class="wf-run-step ${selected && selected.nodeId === s.nodeId ? 'is-selected' : ''}"
                         data-step-id="${escapeHtml(s.nodeId)}" data-status="${s.status}" role="button" tabindex="0">
                        <span class="wf-run-step-rail ${i === steps.length - 1 ? 'is-last' : ''}">
                            <span class="wf-run-light" data-status="${s.status}"></span>
                        </span>
                        <span class="wf-run-step-name" title="${escapeHtml(s.pluginId)}">${escapeHtml(s.name)}</span>
                        <span class="wf-run-step-preview">${escapeHtml(preview || STATUS_TEXT[s.status] || '')}</span>
                        <span class="wf-run-step-dur mono">${dur}</span>
                    </div>
                `;
            }).join('');
            const runError = this.run.error && !steps.some(s => s.status === 'error')
                ? `<div class="wf-run-error-block">${escapeHtml(this.run.error)}</div>` : '';
            return `
                <div class="wf-run-list">${runError}${list}</div>
                <div class="wf-run-detail">${this.detailInner(selected)}</div>
            `;
        }

        detailInner(step) {
            this.shownStepId = step ? step.nodeId : null;
            if (!step) {
                return '<div class="wf-run-empty">点左侧任一步查看输出，并在画布上定位该节点。</div>';
            }
            const head = `
                <div class="wf-run-detail-head">
                    <span class="wf-run-light" data-status="${step.status}"></span>
                    <span class="wf-run-detail-name">${escapeHtml(step.name)}</span>
                    <span class="wf-run-detail-meta">${escapeHtml(STATUS_TEXT[step.status] || step.status)}${step.attempts > 1 ? ` · 尝试 ${step.attempts} 次` : ''}${step.startedAt && step.finishedAt ? ` · ${formatDuration(step.finishedAt - step.startedAt)}` : ''}</span>
                    ${(step.error || step.result !== undefined) ? '<button class="wf-run-copy" data-run-action="copy" type="button">复制</button>' : ''}
                </div>
            `;
            if (step.status === 'error') {
                return head + `<div class="wf-run-error-block">${escapeHtml(step.error || '节点执行失败')}</div>`;
            }
            if (step.status === 'skipped') {
                return head + '<div class="wf-run-empty">上游失败或必需输入未就绪，此节点未执行。</div>';
            }
            if (step.status === 'notrun') {
                return head + '<div class="wf-run-empty">运行在此之前已结束（失败或停止），这个节点没有轮到。</div>';
            }
            if (step.result === undefined) {
                return head + `<div class="wf-run-empty">${step.status === 'pending' ? '尚未开始。' : '等待输出…'}</div>`;
            }
            const text = resultToText(step.result);
            const image = findImageUrl(step.result);
            const imageHtml = image ? `<img class="wf-run-image" src="${escapeHtml(image)}" alt="节点输出图片">` : '';
            const clipped = text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断，复制可得全文）' : text;
            return head + imageHtml + `<pre class="wf-run-output">${escapeHtml(clipped)}</pre>`;
        }
    }

    WorkflowEditor_RunPanel.formatDuration = formatDuration;
    WorkflowEditor_RunPanel.resultToText = resultToText;
    window.WorkflowEditor_RunPanel = new WorkflowEditor_RunPanel();
})();
