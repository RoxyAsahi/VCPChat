const api = window.utilityAPI || window.electronAPI;

const STORAGE_KEYS = {
    lineLimit: 'vcp-log-center-line-limit',
    reverseOrder: 'vcp-log-center-reverse-order'
};

const PRESET_FILTERS = ['IP', 'TOOL', 'RAG', 'POST', 'PLUGIN', 'ERROR'];
const POLL_INTERVAL_MS = 1800;

let serverBaseUrl = '';
let apiAuthHeader = '';
let allLines = [];
let currentOffset = 0;
let currentLogPath = '';
let isReverseOrder = false;
let lineLimit = 500;
let pollTimer = null;
let isLoading = false;
let activePreset = '';
let currentFilter = '';
let scrollHideTimer = null;
let suppressScrollReveal = false;

// next 模式演示层状态：keyed 行渲染 + VCPUI 控件引用。
let nextLogRender = false;
let nextLogSeq = 0;
let nextOrderButton = null;
let nextPresetSelect = null;
let nextEmptyEl = null;
let nextLogLoadStarted = false;

function isNextUiMode() {
    return document.documentElement.dataset.uiMode === 'next'
        && window.VCPUiModeController?.getCurrentMode() === 'next';
}

// 稳定 keyed 协调：按 key 增量更新容器子节点（追加/移除/仅移动次序变化的节点）。
function reconcileByKey(container, items, keyFn, createFn) {
    const current = new Map();
    for (const child of container.children) {
        if (child.dataset?.key) current.set(child.dataset.key, child);
    }
    const seen = new Set();
    let prevSibling = null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const key = keyFn(items[index]);
        seen.add(key);
        let element = current.get(key);
        if (!element) {
            element = createFn(items[index], key);
            element.dataset.key = key;
        }
        if (prevSibling) container.insertBefore(element, prevSibling);
        else container.appendChild(element);
        prevSibling = element;
    }
    for (const [key, element] of current) {
        if (!seen.has(key)) element.remove();
    }
}

const elements = {
    status: document.getElementById('log-status'),
    meta: document.getElementById('log-meta'),
    lines: document.getElementById('log-lines'),
    empty: document.getElementById('empty-state'),
    toast: document.getElementById('toast'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmOkBtn: document.getElementById('confirm-ok-btn'),
    confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
    refreshBtn: document.getElementById('refresh-log-btn'),
    clearBtn: document.getElementById('clear-log-btn'),
    orderBtn: document.getElementById('order-toggle-btn'),
    copyBtn: document.getElementById('copy-visible-btn'),
    lineLimitInput: document.getElementById('line-limit-input'),
    filterInput: document.getElementById('log-filter-input'),
    scrollTopBtn: document.getElementById('scroll-top-btn'),
    scrollBottomBtn: document.getElementById('scroll-bottom-btn')
};

document.addEventListener('DOMContentLoaded', async () => {
    setupWindowControls();
    setupTheme();
    setupSettings();
    setupEvents();

    await initAuthAndServer();
    if (serverBaseUrl && apiAuthHeader) {
        await fetchLog({ incremental: false, silent: false });
        startPolling();
    }
});

window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
});

function setupWindowControls() {
    document.getElementById('minimize-log-btn')?.addEventListener('click', () => api?.minimizeWindow?.());
    document.getElementById('maximize-log-btn')?.addEventListener('click', () => api?.maximizeWindow?.());
    document.getElementById('close-log-btn')?.addEventListener('click', () => {
        if (api?.closeWindow) {
            api.closeWindow();
            return;
        }
        window.close();
    });
}

async function setupTheme() {
    try {
        if (api?.getCurrentTheme) {
            const theme = await api.getCurrentTheme();
            document.body.classList.toggle('light-theme', theme === 'light');
        } else {
            const settings = await api?.loadSettings?.();
            if (settings?.currentThemeMode) {
                document.body.classList.toggle('light-theme', settings.currentThemeMode === 'light');
            }
        }
        api?.onThemeUpdated?.((theme) => {
            document.body.classList.toggle('light-theme', theme === 'light');
        });
    } catch (error) {
        console.warn('[LogCenter] Theme setup failed:', error);
    }
}

function setupSettings() {
    const savedLimit = parseInt(localStorage.getItem(STORAGE_KEYS.lineLimit) || '500', 10);
    lineLimit = normalizeLineLimit(savedLimit);
    elements.lineLimitInput.value = String(lineLimit);

    isReverseOrder = localStorage.getItem(STORAGE_KEYS.reverseOrder) === 'true';
    updateOrderButton();
    updatePresetButtons();
}

function setupEvents() {
    elements.refreshBtn?.addEventListener('click', async () => {
        await fetchLog({ incremental: false, silent: false });
    });

    elements.clearBtn?.addEventListener('click', openClearConfirmModal);

    elements.orderBtn?.addEventListener('click', () => {
        isReverseOrder = !isReverseOrder;
        localStorage.setItem(STORAGE_KEYS.reverseOrder, String(isReverseOrder));
        updateOrderButton();
        render();
    });

    elements.copyBtn?.addEventListener('click', copyVisibleLogs);

    elements.lineLimitInput?.addEventListener('change', () => {
        lineLimit = normalizeLineLimit(parseInt(elements.lineLimitInput.value || '500', 10));
        elements.lineLimitInput.value = String(lineLimit);
        localStorage.setItem(STORAGE_KEYS.lineLimit, String(lineLimit));
        trimLines();
        render();
    });

    elements.filterInput?.addEventListener('input', debounce(() => {
        currentFilter = elements.filterInput.value.trim();
        render();
    }, 120));

    document.querySelectorAll('.preset-chip').forEach((button) => {
        button.addEventListener('click', () => {
            activePreset = button.dataset.filter || '';
            if (activePreset) {
                elements.filterInput.value = activePreset;
                currentFilter = activePreset;
            } else {
                elements.filterInput.value = '';
                currentFilter = '';
            }
            updatePresetButtons();
            render();
        });
    });

    elements.scrollTopBtn?.addEventListener('click', () => {
        revealFloatingActions();
        scheduleFloatingActionsHide();
        suppressScrollReveal = true;
        elements.lines.scrollTo({ top: 0, behavior: 'smooth' });
    });

    elements.scrollBottomBtn?.addEventListener('click', () => {
        revealFloatingActions();
        scheduleFloatingActionsHide();
        suppressScrollReveal = true;
        elements.lines.scrollTo({ top: elements.lines.scrollHeight, behavior: 'smooth' });
    });

    elements.lines?.addEventListener('scroll', () => {
        if (suppressScrollReveal) {
            suppressScrollReveal = false;
            return;
        }
        revealFloatingActions();
        scheduleFloatingActionsHide();
    }, { passive: true });

    hideFloatingActions();
}

async function initAuthAndServer() {
    setStatus('正在读取 VCP 设置...');
    try {
        const settings = await api?.loadSettings?.();
        if (!settings?.vcpServerUrl) {
            setStatus('未配置 VCP 服务器 URL');
            if (isNextUiMode()) showLogErrorNext('未配置 VCP 服务器 URL，请先在主设置中配置。');
            else showToast('请先在主设置中配置 VCP 服务器 URL');
            return;
        }

        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        const forumConfig = await api?.loadForumConfig?.();
        if (!forumConfig?.username || !forumConfig?.password) {
            setStatus('缺少论坛管理员凭据');
            if (isNextUiMode()) showLogErrorNext('未找到论坛模块登录配置，请先在论坛模块登录并保存凭据。');
            else showToast('未找到论坛模块登录配置，请先在论坛模块登录并保存凭据');
            return;
        }

        apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        setStatus('已连接配置，准备读取日志');
    } catch (error) {
        console.error('[LogCenter] Init failed:', error);
        setStatus(`初始化失败: ${error.message}`);
        if (isNextUiMode()) showLogErrorNext(`初始化失败：${error.message}`);
        else showToast(`初始化失败: ${error.message}`);
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        fetchLog({ incremental: true, silent: true }).catch((error) => {
            console.warn('[LogCenter] Poll failed:', error);
        });
    }, POLL_INTERVAL_MS);
}

async function fetchLog({ incremental, silent }) {
    if (!serverBaseUrl || !apiAuthHeader || isLoading) return;
    isLoading = true;
    elements.refreshBtn?.classList.add('spinning');
    if (!incremental && !silent && isNextUiMode()) showLogLoadingNext();

    try {
        if (!silent) setStatus(incremental ? '正在增量刷新...' : '正在读取日志...');

        const endpoint = new URL(`${serverBaseUrl}admin_api/server-log`);
        if (incremental) {
            endpoint.searchParams.set('incremental', 'true');
            endpoint.searchParams.set('offset', String(currentOffset || 0));
        }

        const response = await fetch(endpoint.toString(), {
            method: 'GET',
            headers: {
                Authorization: apiAuthHeader,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || data.details || `HTTP ${response.status}`);
        }

        if (data.needFullReload) {
            currentOffset = 0;
            await fetchLog({ incremental: false, silent: true });
            return;
        }

        currentOffset = Number(data.offset || 0);
        currentLogPath = data.path || currentLogPath;

        if (!incremental) {
            allLines = splitLogLines(data.content || '');
        } else if (data.content) {
            allLines.push(...splitLogLines(data.content));
        }

        trimLines();
        render();

        const sizeText = data.fileSize ? formatBytes(data.fileSize) : '--';
        setStatus(currentLogPath ? `监听: ${currentLogPath}` : '日志已载入');
        setMeta(`总行 ${allLines.length} · 偏移 ${currentOffset} · 文件 ${sizeText}`);
    } catch (error) {
        console.error('[LogCenter] Fetch log failed:', error);
        setStatus(`读取失败: ${error.message}`);
        if (isNextUiMode()) showLogErrorNext(error.message);
        else if (!silent) showToast(`读取日志失败: ${error.message}`);
    } finally {
        isLoading = false;
        elements.refreshBtn?.classList.remove('spinning');
    }
}

function openClearConfirmModal() {
    if (window.VCPUiModeController?.getCurrentMode() === 'next' && window.VCPUI) {
        window.VCPUI.feedback.confirm({
            title: '确认清空日志',
            message: '确定要清空后端服务器日志吗？此操作不可撤销。',
            danger: true,
            confirmLabel: '清空日志',
        }).then(accepted => {
            if (accepted) clearServerLog();
        });
        return;
    }
    if (!elements.confirmModal) {
        clearServerLog();
        return;
    }

    elements.confirmMessage.textContent = '确定要清空后端服务器日志吗？此操作不可撤销。';
    elements.confirmModal.classList.add('active');
    elements.confirmModal.setAttribute('aria-hidden', 'false');
}

function closeClearConfirmModal() {
    if (!elements.confirmModal) return;
    elements.confirmModal.classList.remove('active');
    elements.confirmModal.setAttribute('aria-hidden', 'true');
}

async function clearServerLog() {
    if (!serverBaseUrl || !apiAuthHeader) return;

    try {
        setStatus('正在清空日志...');
        const response = await fetch(`${serverBaseUrl}admin_api/server-log/clear`, {
            method: 'POST',
            headers: {
                Authorization: apiAuthHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || data.details || `HTTP ${response.status}`);
        }

        allLines = [];
        currentOffset = 0;
        render();
        setMeta('总行 0 · 偏移 0 · 文件已清空');
        setStatus('日志已清空');
        showToast(data.message || '日志已清空');
    } catch (error) {
        console.error('[LogCenter] Clear failed:', error);
        setStatus(`清空失败: ${error.message}`);
        showToast(`清空失败: ${error.message}`);
    } finally {
        closeClearConfirmModal();
    }
}

function render() {
    if (isNextUiMode()) {
        renderLogsNext();
        return;
    }
    const shouldStickBottom = isNearBottom();
    const visibleLines = getVisibleLines();
    const fragment = document.createDocumentFragment();

    visibleLines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'log-row';

        const content = document.createElement('div');
        content.className = 'log-content';
        content.innerHTML = decorateLogLine(line);

        row.appendChild(content);
        fragment.appendChild(row);
    });

    elements.lines.innerHTML = '';
    elements.lines.appendChild(fragment);
    elements.empty.classList.toggle('active', visibleLines.length === 0);

    if (!isReverseOrder && shouldStickBottom) {
        requestAnimationFrame(() => {
            suppressScrollReveal = true;
            elements.lines.scrollTop = elements.lines.scrollHeight;
        });
    }
}

// --- next 模式：keyed 增量行渲染（每行按唯一 id 复用 DOM，避免整页闪烁） ---
function renderLogsNext() {
    const shouldStickBottom = isNearBottom();
    const visibleLines = getVisibleLines();
    // 清除上一次的错误/骨架状态，再进入 keyed 行协调。
    elements.lines.querySelector('.vcp-ui-log-error-box')?.remove();
    const staleSkeleton = elements.lines.querySelector('.vcp-ui-skeleton');
    if (staleSkeleton && visibleLines.length) staleSkeleton.remove();
    reconcileByKey(elements.lines, visibleLines, line => line.id, buildLogRowNext);

    if (visibleLines.length === 0) {
        if (!nextEmptyEl || !nextEmptyEl.element.isConnected) {
            nextEmptyEl = window.VCPUI.create('EmptyState', {
                icon: 'article',
                title: '暂无日志内容',
                description: '当前筛选条件下没有可显示的日志行。',
            });
        }
        elements.lines.replaceChildren(nextEmptyEl.element);
    } else if (nextEmptyEl?.element?.isConnected) {
        nextEmptyEl.element.remove();
    }

    if (!isReverseOrder && shouldStickBottom) {
        requestAnimationFrame(() => {
            suppressScrollReveal = true;
            elements.lines.scrollTop = elements.lines.scrollHeight;
        });
    }
}

function buildLogRowNext(line) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const content = document.createElement('div');
    content.className = 'log-content';
    content.innerHTML = decorateLogLine(line.text);
    row.appendChild(content);
    return row;
}

function getVisibleLines() {
    const filter = currentFilter.toLowerCase();
    let lines = allLines;

    if (filter) {
        lines = lines.filter((line) => line.text.toLowerCase().includes(filter));
    }

    if (isReverseOrder) {
        lines = [...lines].reverse();
    }

    return lines;
}

function decorateLogLine(line) {
    const escaped = escapeHtml(line);
    const levelMatch = escaped.match(/\[(LOG|INFO|WARN|WARNING|ERROR|FATAL|DEBUG)\]/i);
    let result = escaped;

    if (levelMatch) {
        const level = levelMatch[1].toLowerCase();
        result = result.replace(levelMatch[0], `<span class="log-level level-${level}">${levelMatch[0]}</span>`);
    }

    if (currentFilter) {
        result = highlightTerm(result, currentFilter);
    }

    return result;
}

function highlightTerm(html, term) {
    const safeTerm = escapeRegExp(escapeHtml(term));
    if (!safeTerm) return html;
    return html.replace(new RegExp(safeTerm, 'ig'), (match) => `<span class="keyword-hit">${match}</span>`);
}

function splitLogLines(content) {
    return content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line, index, arr) => line.length > 0 || index < arr.length - 1)
        .map(text => {
            nextLogSeq += 1;
            return { id: `logline-${nextLogSeq}`, text };
        });
}

function trimLines() {
    if (allLines.length > lineLimit) {
        allLines = allLines.slice(allLines.length - lineLimit);
    }
}

async function copyVisibleLogs() {
    const visibleLines = getVisibleLines();
    const text = visibleLines.map(line => line.text).join('\n');
    if (!text) {
        showToast('没有可复制的可见日志');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast(`已复制 ${visibleLines.length} 行可见日志`);
    } catch (error) {
        console.error('[LogCenter] Clipboard failed:', error);
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        showToast('已复制可见日志');
    } catch (error) {
        showToast(`复制失败: ${error.message}`);
    } finally {
        textarea.remove();
    }
}

function updateOrderButton() {
    elements.orderBtn.textContent = isReverseOrder ? '正序显示' : '倒序显示';
    elements.orderBtn.title = isReverseOrder ? '当前为倒序，点击切换为正序' : '当前为正序，点击切换为倒序';
    if (isNextUiMode() && nextOrderButton) {
        nextOrderButton.update({ label: isReverseOrder ? '正序显示' : '倒序显示' });
    }
}

function updatePresetButtons() {
    document.querySelectorAll('.preset-chip').forEach((button) => {
        button.classList.toggle('active', (button.dataset.filter || '') === activePreset);
    });
}

function setStatus(message) {
    elements.status.textContent = message;
}

function setMeta(message) {
    elements.meta.textContent = message;
}

function showToast(message) {
    if (window.VCPUiModeController?.getCurrentMode() === 'next' && window.VCPUI) {
        window.VCPUI.feedback.toast(message, { variant: 'info' });
        return;
    }
    elements.toast.textContent = message;
    elements.toast.classList.add('active');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        elements.toast.classList.remove('active');
    }, 2200);
}

function revealFloatingActions() {
    elements.scrollTopBtn?.closest('.floating-actions')?.classList.add('visible');
}

function hideFloatingActions() {
    elements.scrollTopBtn?.closest('.floating-actions')?.classList.remove('visible');
}

function scheduleFloatingActionsHide() {
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => {
        hideFloatingActions();
    }, 2000);
}

elements.confirmOkBtn?.addEventListener('click', clearServerLog);
elements.confirmCancelBtn?.addEventListener('click', closeClearConfirmModal);
elements.confirmModal?.addEventListener('click', (event) => {
    if (event.target === elements.confirmModal) {
        closeClearConfirmModal();
    }
});

function isNearBottom() {
    return elements.lines.scrollHeight - elements.lines.scrollTop - elements.lines.clientHeight < 80;
}

function normalizeLineLimit(value) {
    if (!Number.isFinite(value)) return 500;
    return Math.min(20000, Math.max(50, value));
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}
// --- 新版 UI：真实重建页面结构（AppPageShell + VCPUI 控件 + Web Awesome） ---
// 经典模式保持原 DOM/CSS；next 模式将既有业务节点移入 VCPUI 外壳并增强，
// 清空确认与提示改用 VCPUI.feedback（Modal/Toast）。
function buildNextLog() {
    if (!window.VCPUI) return;
    if (window.VCPUiModeController?.getCurrentMode() !== 'next') return;
    if (document.body.classList.contains('vcp-ui-scope')) return;

    const V = window.VCPUI;
    const app = document.querySelector('.log-app');
    if (!app) return;
    document.body.classList.add('vcp-ui-scope');

    const shell = V.create('AppPageShell', {
        title: 'VCP日志中心',
        windowControls: true,
        onMinimize: () => api?.minimizeWindow?.(),
        onMaximize: () => api?.maximizeWindow?.(),
        onClose: () => api?.closeWindow?.(),
    });

    // 动作按钮改为 VCPUI 组合：刷新（IconButton）+ 清空（danger Button，走 confirm）。
    const refresh = V.create('IconButton', { icon: 'refresh', label: '刷新日志', title: '刷新日志', size: 'sm' });
    refresh.element.addEventListener('click', async () => {
        await fetchLog({ incremental: false, silent: false });
    });
    const clear = V.create('Button', { label: '清空日志', variant: 'danger', size: 'sm' });
    clear.element.addEventListener('click', openClearConfirmModal);
    shell.update({ actions: [refresh.element, clear.element] });

    const body = document.createElement('div');
    body.className = 'vcp-ui-log-body';
    while (app.firstChild) body.append(app.firstChild);
    shell.update({ content: body });

    // 移除旧标题栏与自定义 modal/toast（next 模式改用 VCPUI.feedback）。
    document.getElementById('top-nav-bar')?.remove();
    document.getElementById('confirm-modal')?.remove();
    document.getElementById('toast')?.remove();
    app.remove();
    document.body.append(shell.element);

    // 控件增强（保留原生 .value 供业务逻辑使用）。
    [elements.lineLimitInput, elements.filterInput].forEach(input => {
        if (input) { try { V.enhance('Input', input); } catch (error) { console.warn('[Log] enhance input:', error); } }
    });

    deepenNextLog(V, refresh, clear);
}

// --- 新版 UI：深加工 —— VCPUI 管理工具栏 + keyed 行渲染 ---
function deepenNextLog(V, refreshButton, clearButton) {
    const oldControlPanel = document.querySelector('.control-panel');
    const body = document.querySelector('.vcp-ui-log-body');
    nextLogRender = true;

    // 预筛选从 chip 按钮收敛为 VCPUI Select。
    nextPresetSelect = V.create('Select', {
        label: '预筛选',
        options: [{ label: '全部', value: '' }, ...PRESET_FILTERS.map(preset => ({ label: preset, value: preset }))],
        value: activePreset,
        size: 'sm',
    });
    nextPresetSelect.element.addEventListener('change', () => {
        activePreset = nextPresetSelect.element.value || '';
        if (activePreset) {
            elements.filterInput.value = activePreset;
            currentFilter = activePreset;
        } else {
            elements.filterInput.value = '';
            currentFilter = '';
        }
        updatePresetButtons();
        render();
    });

    nextOrderButton = V.create('Button', {
        label: isReverseOrder ? '正序显示' : '倒序显示',
        variant: 'secondary', size: 'sm', icon: 'swap_vert',
    });
    nextOrderButton.element.addEventListener('click', () => {
        isReverseOrder = !isReverseOrder;
        localStorage.setItem(STORAGE_KEYS.reverseOrder, String(isReverseOrder));
        updateOrderButton();
        render();
    });

    const copy = V.create('Button', { label: '复制可见', variant: 'secondary', size: 'sm', icon: 'content_copy' });
    copy.element.addEventListener('click', copyVisibleLogs);

    const toolbar = V.create('Toolbar', {
        label: '日志工具栏',
        start: [elements.filterInput, nextPresetSelect.element, elements.lineLimitInput],
        end: [nextOrderButton.element, copy.element],
    });

    if (body) body.prepend(toolbar.element);
    oldControlPanel?.remove();

    // Tooltip 通过 VCPUI.create('Tooltip') 创建（由 VCPUI 委托 Web Awesome）。
    [refreshButton.element, clearButton.element, elements.scrollTopBtn, elements.scrollBottomBtn].forEach(btn => {
        if (!btn || !btn.isConnected) return;
        try {
            const tip = V.create('Tooltip', { trigger: btn, content: btn.title || btn.getAttribute('aria-label') || '操作', placement: 'top' });
            document.body.append(tip.element);
        } catch (error) { /* ignore */ }
    });

    render();
}

// next 模式：首屏加载骨架屏与错误 Alert+重试。
function showLogLoadingNext() {
    if (!isNextUiMode() || !window.VCPUI) return;
    const skeleton = window.VCPUI.create('Skeleton', { variant: 'text', lines: 8 });
    elements.lines.replaceChildren(skeleton.element);
}

function showLogErrorNext(message) {
    if (!isNextUiMode() || !window.VCPUI) return;
    const alert = window.VCPUI.create('Alert', { title: '读取失败', message, variant: 'danger' });
    const retry = window.VCPUI.create('Button', { label: '重试', variant: 'secondary', icon: 'refresh' });
    retry.element.addEventListener('click', async () => {
        await fetchLog({ incremental: false, silent: false });
    });
    const box = document.createElement('div');
    box.className = 'vcp-ui-log-error-box';
    box.append(alert.element, retry.element);
    elements.lines.replaceChildren(box);
}
window.addEventListener('vcp-ui-runtime-ready', buildNextLog);
