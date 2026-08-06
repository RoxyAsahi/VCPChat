import { createWorkspacePathRef } from './agent-workspace-model.js';
import { button, iconButton, node } from './agent-workbench-dom.js';
import { getWorkspacePreviewModes, renderWorkspacePreviewContent } from './agent-workspace-preview-registry.js';

function createAgentWorkspaceView({ document = globalThis.document, actions = {} }) {
    const element = node('section', 'agent-workspace-browser', undefined, document);
    let dragCleanup = null;

    function pathActions(ref) {
        const controls = node('div', 'agent-workspace-path-actions', undefined, document);
        for (const [action, label, iconName] of [
            ['open-in-vchat', '在 VChat 中打开', 'tab'],
            ['copy-relative-path', '复制相对路径', 'content_copy'],
            ['copy-absolute-path', '复制绝对路径', 'file_copy'],
            ['reveal-in-explorer', '在资源管理器中显示', 'folder_open'],
            ['open-with-system', '使用系统程序打开', 'open_in_new'],
        ]) {
            const control = iconButton(iconName, label, 'agent-workspace-path-action', document);
            control.addEventListener('click', () => actions.run?.(() => action === 'open-in-vchat'
                ? actions.openFileTab?.(ref)
                : actions.performPathAction?.(ref, action)));
            controls.append(control);
        }
        return controls;
    }

    function buildPreview(browser) {
        const host = node('section', 'agent-workspace-preview', undefined, document);
        if (browser.previewLoading) {
            const loading = node('div', 'agent-workspace-empty', undefined, document);
            loading.append(
                node('span', 'vcp-ui-icon agent-workspace-empty-icon', 'hourglass_top', document),
                node('span', '', '正在读取预览…', document),
            );
            host.append(loading);
            return host;
        }
        const preview = browser.preview;
        if (!preview) {
            const empty = node('div', 'agent-workspace-empty', undefined, document);
            empty.append(
                node('span', 'vcp-ui-icon agent-workspace-empty-icon', 'description', document),
                node('strong', '', '选择文件以预览', document),
                node('span', '', '双击文件可固定到顶部标签栏', document),
            );
            host.append(empty);
            return host;
        }
        const ref = createWorkspacePathRef({
            sessionId: preview.sessionId,
            workspaceRevision: preview.workspaceRevision,
            relativePath: preview.relativePath,
            kind: 'file',
            source: 'tree',
        });
        const header = node('header', 'agent-workspace-preview-header', undefined, document);
        const identity = node('div', 'agent-workspace-preview-identity', undefined, document);
        identity.append(
            node('span', 'vcp-ui-icon agent-workspace-preview-file-icon', 'draft', document),
            node('span', 'agent-workspace-preview-name', preview.displayName || preview.relativePath.split('/').pop(), document),
            node('span', 'agent-workspace-preview-path', preview.relativePath, document),
        );
        const headerActions = pathActions(ref);
        let saveControl = null;
        const modes = getWorkspacePreviewModes(preview);
        if (modes.length > 1) {
            const modeControl = node('div', 'agent-workspace-preview-modes', undefined, document);
            modeControl.setAttribute('role', 'group');
            modeControl.setAttribute('aria-label', '文件显示模式');
            for (const [mode, label] of [['preview', '预览'], ['source', '源码'], ['edit', '编辑']]) {
                if (!modes.includes(mode)) continue;
                const modeButton = button(label, 'agent-workspace-preview-mode', document);
                modeButton.classList.toggle('is-active', browser.previewMode === mode);
                modeButton.setAttribute('aria-pressed', String(browser.previewMode === mode));
                modeButton.addEventListener('click', () => actions.setPreviewMode?.(mode));
                modeControl.append(modeButton);
            }
            headerActions.prepend(modeControl);
        }
        if (browser.previewMode === 'edit') {
            saveControl = iconButton('save', browser.editSaving ? '正在保存' : '保存文件', 'agent-workspace-path-action', document);
            saveControl.disabled = browser.editSaving || !browser.editDirty;
            saveControl.addEventListener('click', () => actions.run?.(() => actions.saveText?.(ref)));
            headerActions.prepend(saveControl);
        }
        if (browser.editError) {
            const reload = iconButton('refresh', '放弃草稿并重新加载', 'agent-workspace-path-action', document);
            reload.addEventListener('click', () => {
                const confirmed = !browser.editDirty || document.defaultView?.confirm?.('放弃未保存的修改并重新加载文件？');
                if (confirmed) actions.run?.(() => actions.openPreview?.(ref));
            });
            headerActions.prepend(reload);
        }
        const pin = iconButton('keep', '固定到顶部标签栏', 'agent-workspace-path-action', document);
        pin.addEventListener('click', () => actions.run?.(() => actions.openFileTab?.(ref)));
        headerActions.prepend(pin);
        header.append(identity, headerActions);
        host.append(header);
        if (browser.editError) host.append(node('div', 'agent-workspace-error', browser.editError, document));
        host.append(renderWorkspacePreviewContent({ preview, browser, actions: {
            ...actions,
            saveText: () => actions.saveText?.(ref),
            syncDirty: (dirty) => { if (saveControl) saveControl.disabled = browser.editSaving || !dirty; },
        }, document }));
        if (preview.truncated) {
            host.append(node('div', 'agent-workspace-preview-note', `已截断 · ${preview.byteLen} bytes`, document));
        }
        return host;
    }

    function update({ identity = {}, browser } = {}) {
        dragCleanup?.();
        element.replaceChildren();
        if (!browser || !identity.sessionId || !identity.workspaceRoot) {
            element.append(node('div', 'agent-chat-activity-empty', '当前会话没有可浏览的工作目录。', document));
            return;
        }
        const toolbar = node('header', 'agent-workspace-toolbar', undefined, document);
        const searchWrap = node('label', 'agent-workspace-search-wrap', undefined, document);
        searchWrap.append(node('span', 'vcp-ui-icon', 'search', document));
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'agent-workspace-search';
        search.placeholder = '搜索工作区文件';
        search.value = browser.search;
        search.setAttribute('aria-label', '搜索工作区文件');
        search.addEventListener('input', () => actions.search?.(search.value));
        searchWrap.append(search);
        toolbar.append(searchWrap);

        const explorerPane = node('section', 'agent-workspace-explorer-pane', undefined, document);
        explorerPane.append(toolbar);
        if (browser.error) explorerPane.append(node('div', 'agent-workspace-error', browser.error, document));
        const rows = browser.search.trim()
            ? browser.searchResults.map((entry) => ({ entry, depth: 0 }))
            : browser.model.flatten();
        const list = node('div', 'agent-workspace-tree', undefined, document);
        list.setAttribute('role', 'tree');
        const treeMeta = node('div', 'agent-workspace-tree-meta', undefined, document);
        treeMeta.append(
            node('span', '', browser.search.trim() ? `搜索结果 · ${rows.length}` : `项目文件 · ${rows.length}`, document),
            browser.model.isLoading('')
                ? node('span', 'agent-workspace-tree-loading', '读取中…', document)
                : node('span', '', '', document),
        );
        list.append(treeMeta);
        if (browser.searchLoading) list.append(node('div', 'agent-chat-activity-empty', '正在搜索…', document));
        for (const [index, { entry, depth }] of rows.slice(0, 5000).entries()) {
            const row = button('', 'agent-workspace-tree-row', document);
            row.dataset.workspacePath = entry.relativePath;
            row.dataset.workspaceIndex = String(index);
            row.classList.toggle('is-selected', browser.selectedPath === entry.relativePath);
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(depth + 1));
            const indentation = node('span', 'agent-workspace-tree-indent', undefined, document);
            for (let level = 0; level < Math.min(depth, 32); level += 1) {
                indentation.append(node('span', 'agent-workspace-tree-indent-unit', undefined, document));
            }
            const directory = entry.kind === 'directory';
            row.append(directory
                ? node('span', 'vcp-ui-icon agent-workspace-tree-chevron', browser.model.isExpanded(entry.relativePath) ? 'expand_more' : 'chevron_right', document)
                : node('span', 'agent-workspace-tree-chevron', '', document));
            row.append(
                indentation,
                node('span', 'vcp-ui-icon agent-workspace-tree-icon', directory
                    ? (browser.model.isExpanded(entry.relativePath) ? 'folder_open' : 'folder')
                    : 'description', document),
                node('span', 'agent-workspace-tree-name', entry.name, document),
            );
            if (directory) row.setAttribute('aria-expanded', String(browser.model.isExpanded(entry.relativePath)));
            row.addEventListener('click', () => actions.run?.(async () => {
                if (directory) {
                    const expanded = !browser.model.isExpanded(entry.relativePath);
                    browser.model.setExpanded(entry.relativePath, expanded);
                    if (expanded) await actions.loadDirectory?.(entry.relativePath);
                    else actions.refresh?.();
                } else {
                    await actions.openPreview?.(createWorkspacePathRef({
                        sessionId: browser.sessionId,
                        workspaceRevision: browser.workspaceRevision,
                        relativePath: entry.relativePath,
                        source: 'tree',
                    }));
                }
            }));
            row.addEventListener('dblclick', () => {
                if (!directory) actions.run?.(() => actions.openFileTab?.(createWorkspacePathRef({
                    sessionId: browser.sessionId,
                    workspaceRevision: browser.workspaceRevision,
                    relativePath: entry.relativePath,
                    source: 'tree',
                })));
            });
            list.append(row);
        }
        if (rows.length > 5000) {
            list.append(node('div', 'agent-workspace-preview-note', '仅显示前 5000 项，请使用搜索缩小范围。', document));
        }
        list.addEventListener('keydown', (event) => {
            const visibleRows = [...list.querySelectorAll('.agent-workspace-tree-row')];
            const currentIndex = visibleRows.indexOf(document.activeElement);
            if (event.key === 'ArrowDown' && visibleRows[currentIndex + 1]) { event.preventDefault(); visibleRows[currentIndex + 1].focus(); }
            if (event.key === 'ArrowUp' && visibleRows[currentIndex - 1]) { event.preventDefault(); visibleRows[currentIndex - 1].focus(); }
            if (event.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-expanded') === 'false') { event.preventDefault(); document.activeElement.click(); }
            if (event.key === 'ArrowLeft' && document.activeElement?.getAttribute('aria-expanded') === 'true') { event.preventDefault(); document.activeElement.click(); }
        });
        explorerPane.append(list);

        const previewPane = buildPreview(browser);
        const divider = node('div', 'agent-workspace-splitter', undefined, document);
        divider.tabIndex = 0;
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-orientation', 'vertical');
        divider.setAttribute('aria-label', '调整文件预览与目录树宽度');
        const applySplit = (percent, allowCollapse = true) => {
            browser.splitPercent = allowCollapse && percent >= 90
                ? 100
                : Math.round(Math.max(28, Math.min(88, percent)) / 2) * 2;
            [...element.classList]
                .filter((name) => name.startsWith('agent-workspace-split-'))
                .forEach((name) => element.classList.remove(name));
            element.classList.add(`agent-workspace-split-${browser.splitPercent}`);
            divider.setAttribute('aria-valuenow', String(browser.splitPercent));
        };
        applySplit(browser.splitPercent);
        divider.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            dragCleanup?.();
            divider.setPointerCapture?.(event.pointerId);
            const bounds = element.getBoundingClientRect();
            const onMove = (moveEvent) => applySplit(((moveEvent.clientX - bounds.left) / Math.max(1, bounds.width)) * 100);
            const onUp = (upEvent) => {
                divider.releasePointerCapture?.(upEvent.pointerId);
                dragCleanup?.();
            };
            dragCleanup = () => {
                divider.removeEventListener('pointermove', onMove);
                divider.removeEventListener('pointerup', onUp);
                divider.removeEventListener('pointercancel', onUp);
                dragCleanup = null;
            };
            divider.addEventListener('pointermove', onMove);
            divider.addEventListener('pointerup', onUp);
            divider.addEventListener('pointercancel', onUp);
        });
        divider.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            if (event.key === 'ArrowRight' && browser.splitPercent >= 88) applySplit(100);
            else if (event.key === 'ArrowLeft' && browser.splitPercent === 100) applySplit(88, false);
            else applySplit(browser.splitPercent + (event.key === 'ArrowRight' ? 2 : -2), false);
        });
        element.append(previewPane, divider, explorerPane);
        if (!browser.model.hasChildren('') && !browser.model.isLoading('')) {
            queueMicrotask(() => actions.run?.(() => actions.loadDirectory?.('')));
        }
    }

    return {
        element,
        update,
        renderPreview: buildPreview,
        dispose() {
            dragCleanup?.();
            element.remove();
        },
    };
}

export { createAgentWorkspaceView };
