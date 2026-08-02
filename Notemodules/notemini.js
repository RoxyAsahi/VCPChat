const api = window.utilityAPI || window.electronAPI;

function isNextUi() {
    return window.VCPUiModeController?.getCurrentMode() === 'next';
}

// 真正的新版重建：经典模式保留原 DOM/CSS；next 模式用 VCPUI 组件重建页面
// 结构（AppPageShell + Input/Textarea + WindowControls），并让 Web Awesome
// 适配器真实参与（图标按钮 Tooltip 交由 wa-tooltip 处理）。
function buildNextMiniNote({ titleInput, contentInput, saveStatus, onSave, onClose, onMinimize }) {
    const V = window.VCPUI;
    const inputNode = controller => controller.element.matches?.('input, wa-input')
        ? controller.element
        : controller.element.querySelector('input, wa-input');

    const body = document.createElement('div');
    body.className = 'vcp-ui-mini-note-body';

    const titleField = V.create('Input', { placeholder: '便签标题', label: '便签标题' });
    titleField.element.id = 'miniNoteTitle';
    titleField.element.classList.add('vcp-ui-mini-note-title');
    inputNode(titleField)?.addEventListener('input', onSave);

    const contentField = V.create('Textarea', { placeholder: '快速记录...', label: '便签正文', rows: 6 });
    contentField.element.id = 'miniNoteContent';
    contentField.element.classList.add('vcp-ui-mini-note-content');
    contentField.element.querySelector('textarea').addEventListener('input', onSave);

    body.append(titleField.element, contentField.element);

    const status = document.createElement('span');
    status.className = 'vcp-ui-mini-note-status';
    status.textContent = '未保存';

    const shell = V.create('AppPageShell', {
        title: 'VCP 便签',
        actions: [status],
        windowControls: true,
        onMinimize: onMinimize,
        onClose: onClose,
        content: body,
    });

    document.body.replaceChildren(shell.element);
    document.body.classList.add('vcp-ui-scope');

    // Tooltip 通过 VCPUI.create('Tooltip') 创建（由 VCPUI 委托 Web Awesome）。
    const wireWaTooltips = () => {
        try {
            const root = document.createElement('span');
            const controls = shell.element.querySelector('.vcp-ui-window-controls');
            controls?.querySelectorAll('.vcp-ui-icon-button').forEach(button => {
                const label = button.getAttribute('aria-label') || '';
                const tip = V.create('Tooltip', { trigger: button, content: label, placement: 'top' });
                root.append(tip.element);
            });
            if (root.children.length) controls?.append(root);
        } catch (error) {
            console.warn('[Notemini] Tooltip failed:', error);
        }
    };
    wireWaTooltips();

    return {
        statusEl: status,
        titleField,
        contentField,
        focus: () => inputNode(titleField)?.focus(),
    };
}

document.addEventListener('DOMContentLoaded', async () => {
    const legacyTitle = document.getElementById('miniNoteTitle');
    const legacyContent = document.getElementById('miniNoteContent');
    const legacyStatus = document.getElementById('saveStatus');
    const legacyMinimize = document.getElementById('minimizeMiniBtn');
    const legacyClose = document.getElementById('closeMiniBtn');

    let saveTimer = null;
    let isSaving = false;
    let hasSaved = false;
    let currentFilePath = null;
    let lastSavedSnapshot = '';
    let nextUi = null;

    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    const titleInput = () => nextUi
        ? (nextUi.titleField.element.matches?.('input, wa-input') ? nextUi.titleField.element : nextUi.titleField.element.querySelector('input, wa-input'))
        : legacyTitle;
    const contentInput = () => nextUi ? nextUi.contentField.element.querySelector('textarea') : legacyContent;
    const saveStatus = () => nextUi ? nextUi.statusEl : legacyStatus;

    function setStatus(text, isError = false) {
        const el = saveStatus();
        if (!el) return;
        el.textContent = text;
        if (el.classList) el.classList.toggle('is-error', isError);
        else el.style.color = isError ? 'var(--danger-color)' : '';
    }

    function getSnapshot() {
        return JSON.stringify({ title: titleInput().value, content: contentInput().value });
    }

    function hasMeaningfulContent() {
        return titleInput().value.trim().length > 0 || contentInput().value.trim().length > 0;
    }

    function scheduleSave() {
        setStatus('编辑中...');
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveCurrentNote(), 800);
    }

    async function saveCurrentNote({ force = false } = {}) {
        if (isSaving) return;
        if (!hasMeaningfulContent()) {
            setStatus('空便签');
            return;
        }
        const snapshot = getSnapshot();
        if (!force && snapshot === lastSavedSnapshot) {
            setStatus(hasSaved ? '已保存' : '未保存');
            return;
        }
        isSaving = true;
        setStatus('保存中...');
        try {
            const result = await api.saveMiniNote({
                title: titleInput().value,
                content: contentInput().value,
                filePath: currentFilePath
            });
            if (result?.success) {
                hasSaved = true;
                currentFilePath = result.path || currentFilePath;
                lastSavedSnapshot = snapshot;
                setStatus('已保存');
            } else {
                setStatus(result?.error || '保存失败', true);
            }
        } catch (error) {
            setStatus(error.message || '保存失败', true);
        } finally {
            isSaving = false;
        }
    }

    async function closeNote() {
        if (saveTimer) clearTimeout(saveTimer);
        await saveCurrentNote({ force: true });
        api.closeWindow();
    }

    async function initializeTheme() {
        try {
            const theme = await api.getCurrentTheme?.();
            applyTheme(theme || 'dark');
            api.onThemeUpdated?.(applyTheme);
        } catch {
            applyTheme('dark');
        }
    }

    const onInput = () => scheduleSave();

    document.addEventListener('keydown', async (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (saveTimer) clearTimeout(saveTimer);
            await saveCurrentNote({ force: true });
        }
        if (event.key === 'Escape') {
            if (saveTimer) clearTimeout(saveTimer);
            await saveCurrentNote({ force: true });
            api.closeWindow();
        }
    });

    // 经典模式监听原按钮。
    legacyMinimize?.addEventListener('click', () => api.minimizeWindow());
    legacyClose?.addEventListener('click', closeNote);

    window.addEventListener('beforeunload', () => {
        if (saveTimer) clearTimeout(saveTimer);
    });

    // next 模式重建：vcp-ui-runtime-ready 在 DOMContentLoaded 之后派发，必然被捕获。
    const mountNextUi = () => {
        if (!isNextUi() || nextUi) return;
        nextUi = buildNextMiniNote({
            titleInput: legacyTitle,
            contentInput: legacyContent,
            saveStatus: legacyStatus,
            onSave: onInput,
            onClose: closeNote,
            onMinimize: () => api.minimizeWindow(),
        });
        nextUi.focus();
    };
    window.addEventListener('vcp-ui-runtime-ready', mountNextUi);

    await initializeTheme();
    setStatus('未保存');
    if (!nextUi) legacyTitle?.focus();
});
