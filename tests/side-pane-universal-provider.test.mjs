import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { createNotesSideProvider } from '../modules/ui-system/side-pane/notesSideProvider.js';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createCodeViewerSideProvider, computeLineDiff, detectLanguage } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import { createGitSideProvider } from '../modules/ui-system/side-pane/gitSideProvider.js';
import { createBrowserSideProvider, normalizeBrowserInput, BROWSER_PARTITION } from '../modules/ui-system/side-pane/browserSideProvider.js';

test('SidePaneState: exports TAB_KINDS and supports generic openTab', () => {
    assert.ok(SidePaneState.TAB_KINDS);
    assert.equal(SidePaneState.TAB_KINDS.NOTES, 'notes');
    assert.equal(SidePaneState.TAB_KINDS.CODE_VIEWER, 'code-viewer');
    assert.equal(SidePaneState.TAB_KINDS.GIT, 'git');
    assert.equal(SidePaneState.TAB_KINDS.WORKSPACE, 'workspace');
    assert.equal(SidePaneState.TAB_KINDS.TOOL_OUTPUT, 'tool-output');

    let state = SidePaneState.createInitialSidePaneState();
    assert.equal(state.tabs.length, 1); // notifications

    // Open a notes tab
    state = SidePaneState.openTab(state, {
        id: 'side-pane-notes',
        kind: 'notes',
        title: '随手笔记',
        icon: 'edit_note',
        closable: true,
        scopeMode: 'global'
    });

    assert.equal(state.tabs.length, 2);
    assert.equal(state.activeTabId, 'side-pane-notes');
    assert.equal(state.visible, true);
    assert.equal(state.tabs[1].kind, 'notes');
    assert.equal(state.tabs[1].icon, 'edit_note');
    assert.equal(state.tabs[1].scopeMode, 'global');

    // Global tab remains visible across different parent topic references
    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const visibleA = SidePaneState.getVisibleTabs(state, parentA);
    assert.deepEqual(visibleA.map(t => t.id), ['notifications', 'side-pane-notes']);

    const parentB = { itemType: 'agent', itemId: 'agent-2', topicId: 'topic-b' };
    const visibleB = SidePaneState.getVisibleTabs(state, parentB);
    assert.deepEqual(visibleB.map(t => t.id), ['notifications', 'side-pane-notes']);
});

test('SidePaneController: registers and dispatches universal tab providers', async () => {
    const dom = new JSDOM(`
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
            </div>
        </aside>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    const mountedTabs = [];
    const mockProvider = {
        async mountTab(tab, view) {
            mountedTabs.push(tab.id);
            view.innerHTML = `<div class="mock-content">${tab.title}</div>`;
            return {
                focus() {},
                async dispose() {}
            };
        }
    };

    const controller = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        providers: {
            custom: mockProvider
        }
    });

    await controller.openTab({
        id: 'custom-tab-1',
        kind: 'custom',
        title: '自定义副屏视图',
        icon: 'star',
        scopeMode: 'global'
    });

    assert.equal(mountedTabs.includes('custom-tab-1'), true);
    assert.equal(controller.getSnapshot().activeTabId, 'custom-tab-1');

    const renderedTab = tabList.querySelector('[data-tab-id="custom-tab-1"]');
    assert.ok(renderedTab);
    assert.equal(renderedTab.querySelector('.tab-icon').textContent, 'star');
    assert.equal(renderedTab.querySelector('.tab-title').textContent, '自定义副屏视图');

    const view = content.querySelector('[data-tab-id="custom-tab-1"]');
    assert.ok(view);
    assert.equal(view.querySelector('.mock-content').textContent, '自定义副屏视图');
});

test('NotesSideProvider: mounts sub-screen notes UI and supports autosave, chat insert, and grab', async () => {
    const dom = new JSDOM(`
        <div id="chatMessages">
            <div class="message-item assistant">
                <div class="md-content">这是 AI 提供的核心架构解答方案。</div>
            </div>
        </div>
        <textarea id="messageInput"></textarea>
        <div id="notesContainer"></div>
    `);
    const doc = dom.window.document;
    const viewElement = doc.getElementById('notesContainer');
    const messageInput = doc.getElementById('messageInput');

    const savedNotes = [];
    let copyCalls = 0;
    const mockElectronAPI = {
        async readNotesTree() {
            // Real shape from read-notes-tree: notes are type 'note' with title/content, folders nest children.
            return [
                { id: 'n1', type: 'note', title: '项目备忘', content: '# 项目备忘正文', path: '/notes/项目备忘.md', fileName: '项目备忘.md' },
                {
                    id: 'f1',
                    type: 'folder',
                    name: '归档',
                    path: '/notes/归档',
                    children: [
                        { id: 'n2', type: 'note', title: '临时思路', content: '临时思路正文', path: '/notes/归档/临时思路.txt', fileName: '临时思路.txt' }
                    ]
                }
            ];
        },
        async saveMiniNote(noteData) {
            savedNotes.push({ ...noteData });
            return { success: true, path: noteData.filePath || '/notes/new.md' };
        },
        async copyNoteContent() {
            // Real handler only writes to the clipboard and returns { success: true }; the provider must never rely on it.
            copyCalls++;
            return { success: true };
        }
    };

    const toasts = [];
    const mockUiHelper = {
        showToastNotification(msg, type) {
            toasts.push({ msg, type });
        }
    };

    const notesProvider = createNotesSideProvider({
        electronAPI: mockElectronAPI,
        uiHelper: mockUiHelper
    });

    assert.equal(notesProvider.kind, 'notes');

    const handle = await notesProvider.mountTab({ id: 'side-pane-notes', kind: 'notes' }, viewElement);
    assert.ok(handle);

    // Verify UI Structure
    const toolbar = viewElement.querySelector('.side-notes-toolbar');
    assert.ok(toolbar);
    const select = toolbar.querySelector('.side-notes-select');
    assert.ok(select);
    // Should have populated the options from readNotesTree
    assert.equal(select.options.length, 3); // __new__, 项目备忘, 归档 / 临时思路
    assert.equal(select.options[2].textContent, '归档 / 临时思路');

    // Selecting an existing note loads its real content from the tree, without touching the clipboard
    select.value = '/notes/项目备忘.md';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(viewElement.querySelector('.side-notes-title-input').value, '项目备忘');
    assert.equal(viewElement.querySelector('.side-notes-content-textarea').value, '# 项目备忘正文');
    assert.equal(copyCalls, 0);
    assert.equal(savedNotes.length, 0, 'loading a note must not save it back');
    select.value = '__new__';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 30));

    const titleInput = viewElement.querySelector('.side-notes-title-input');
    const textarea = viewElement.querySelector('.side-notes-content-textarea');
    assert.ok(titleInput);
    assert.ok(textarea);

    // Test typing and autosave
    titleInput.value = '测试便签';
    textarea.value = '第一行便签内容';
    titleInput.dispatchEvent(new dom.window.Event('input'));

    // Wait for debounced autosave (600ms + buffer)
    await new Promise(resolve => setTimeout(resolve, 750));

    assert.equal(savedNotes.length, 1);
    assert.equal(savedNotes[0].title, '测试便签');
    assert.equal(savedNotes[0].content, '第一行便签内容');

    // Test: Insert to Main Chat
    const insertBtn = viewElement.querySelector('[data-action="insert-to-chat"]');
    assert.ok(insertBtn);
    insertBtn.click();

    assert.equal(messageInput.value.includes('【笔记：测试便签】'), true);
    assert.equal(messageInput.value.includes('第一行便签内容'), true);
    assert.equal(toasts.some(t => t.msg.includes('已将便签内容插入主聊天输入框')), true);

    // Test: Grab from Main Chat
    const grabBtn = viewElement.querySelector('[data-action="grab-from-chat"]');
    assert.ok(grabBtn);
    grabBtn.click();

    assert.equal(textarea.value.includes('这是 AI 提供的核心架构解答方案。'), true);
    assert.equal(toasts.some(t => t.msg.includes('已成功抓取 AI 回复并存入便签')), true);

    await handle.dispose();
    assert.equal(viewElement.children.length, 0);
});

test('computeLineDiff: accurately computes LCS line diffs and statistics', () => {
    const oldCode = 'line1\nline2\nline3';
    const newCode = 'line1\nline2_modified\nline3\nline4';

    const diff = computeLineDiff(oldCode, newCode);
    assert.equal(diff.addedCount, 2); // line2_modified, line4
    assert.equal(diff.deletedCount, 1); // line2
    assert.equal(diff.rows.length, 5);

    assert.deepEqual(diff.rows[0], { type: 'same', oldLine: 1, newLine: 1, text: 'line1' });
    assert.deepEqual(diff.rows[1], { type: 'del', oldLine: 2, newLine: null, text: 'line2' });
    assert.deepEqual(diff.rows[2], { type: 'add', oldLine: null, newLine: 2, text: 'line2_modified' });
    assert.deepEqual(diff.rows[3], { type: 'same', oldLine: 3, newLine: 3, text: 'line3' });
    assert.deepEqual(diff.rows[4], { type: 'add', oldLine: null, newLine: 4, text: 'line4' });
});

test('detectLanguage: resolves extensions to correct identifiers and display tags', () => {
    assert.deepEqual(detectLanguage('index.js'), { lang: 'javascript', tag: 'JS' });
    assert.deepEqual(detectLanguage('app.tsx'), { lang: 'typescript', tag: 'TSX' });
    assert.deepEqual(detectLanguage('main.py'), { lang: 'python', tag: 'PY' });
    assert.deepEqual(detectLanguage('server.rs'), { lang: 'rust', tag: 'RUST' });
    assert.deepEqual(detectLanguage('patch.diff'), { lang: 'diff', tag: 'DIFF' });
    assert.deepEqual(detectLanguage('unknown.xyz'), { lang: 'xyz', tag: 'XYZ' });
    assert.deepEqual(detectLanguage('no_ext'), { lang: 'plaintext', tag: 'PLAINTEXT' });
});

test('CodeViewerSideProvider: mounts code viewer, toggles wrap, diff mode, and inserts to chat', async () => {
    const dom = new JSDOM(`
        <textarea id="messageInput"></textarea>
        <div id="codeViewerContainer"></div>
    `);
    const doc = dom.window.document;
    const viewElement = doc.getElementById('codeViewerContainer');
    const messageInput = doc.getElementById('messageInput');

    const toasts = [];
    const mockUiHelper = {
        showToastNotification(msg, type) {
            toasts.push({ msg, type });
        }
    };

    const mockApi = {
        async getTextContent(filePath) {
            if (filePath === '/src/test.js') {
                return 'const a = 1;\nconst b = 2;';
            }
            throw new Error('File not found');
        }
    };

    const provider = createCodeViewerSideProvider({
        document: doc,
        api: mockApi,
        uiHelper: mockUiHelper
    });

    assert.equal(provider.kind, 'code-viewer');

    // 1. Mount standard code view
    const handle = await provider.mountTab({
        id: 'code-tab-1',
        kind: 'code-viewer',
        title: 'test.js',
        payload: {
            filePath: '/src/test.js',
            mode: 'view'
        }
    }, viewElement);

    assert.ok(handle);
    assert.equal(handle.getCode(), 'const a = 1;\nconst b = 2;');
    assert.equal(handle.getMode(), 'view');

    // Verify UI Structure
    const toolbar = viewElement.querySelector('.side-code-toolbar');
    assert.ok(toolbar);
    assert.equal(toolbar.querySelector('.side-code-title').textContent, 'test.js');
    assert.equal(toolbar.querySelector('.side-code-lang-tag').textContent, 'JS');

    const gutter = viewElement.querySelector('.side-code-gutter');
    assert.ok(gutter);
    assert.equal(gutter.querySelectorAll('.side-code-line-number').length, 2);

    const pre = viewElement.querySelector('.side-code-pre');
    assert.ok(pre);
    assert.equal(pre.textContent.includes('const a = 1;'), true);

    // Test Toggle Wrap
    const wrapBtn = toolbar.querySelector('[data-action="toggle-wrap"]');
    assert.ok(wrapBtn);
    wrapBtn.click();
    assert.equal(wrapBtn.classList.contains('active'), true);
    assert.equal(viewElement.querySelector('.side-code-editor-shell').classList.contains('is-wrapped'), true);

    // Test Insert to Chat
    const insertBtn = toolbar.querySelector('[data-action="insert-chat"]');
    assert.ok(insertBtn);
    insertBtn.click();

    assert.equal(messageInput.value.includes('```javascript'), true);
    assert.equal(messageInput.value.includes('const a = 1;'), true);
    assert.equal(toasts.some(t => t.msg.includes('代码片段已插入主输入框')), true);

    await handle.dispose();
    assert.equal(viewElement.children.length, 0);

    // 2. Mount Diff View
    const diffHandle = await provider.mountTab({
        id: 'diff-tab-1',
        kind: 'code-viewer',
        title: '差异对比',
        payload: {
            mode: 'diff',
            oldCode: 'const x = 10;\nconst y = 20;',
            newCode: 'const x = 15;\nconst y = 20;\nconst z = 30;'
        }
    }, viewElement);

    assert.ok(diffHandle);
    assert.equal(diffHandle.getMode(), 'diff');

    const statsBar = viewElement.querySelector('.side-diff-stats-bar');
    assert.ok(statsBar);
    assert.equal(statsBar.querySelector('.side-diff-badge.add').textContent, '+2');
    assert.equal(statsBar.querySelector('.side-diff-badge.del').textContent, '-1');

    const diffRows = viewElement.querySelectorAll('.side-diff-row');
    assert.equal(diffRows.length, 4);

    await diffHandle.dispose();
});

test('GitSideProvider: mirrors the ZCode GitPane — source select, flat change cards, expandable diff, context menu', async () => {
    const dom = new JSDOM(`
        <div id="sideGitHost"></div>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const viewElement = doc.getElementById('sideGitHost');

    const stagedChanges = [{ path: 'src/staged.js', status: 'M' }];
    const unstagedChanges = [{ path: 'src/unstaged.js', status: 'M' }, { path: 'notes.txt', status: 'U' }];
    const copied = [];
    const revealed = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } } });
    const toasts = [];

    const mockAPI = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'ws-demo', alias: 'VCPChat-Core', path: '/code/vcpchat' }], activeWorkspaceId: 'ws-demo' } };
        },
        async gitStatus() {
            return { success: true, data: { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [...stagedChanges], changes: [...unstagedChanges], conflicts: [] } };
        },
        async gitDiff(wsId, relPath, { staged }) {
            return {
                success: true,
                data: {
                    path: relPath,
                    staged: Boolean(staged),
                    before: { exists: true, binary: false, text: ['function hello() {}', ''].join('\n'), size: 20, truncated: false },
                    after: { exists: true, binary: false, text: ['function hello() {', '    return 42;', '}', ''].join('\n'), size: 38, truncated: false }
                }
            };
        },
        async gitRevealPath(wsId, relPath) {
            revealed.push([wsId, relPath]);
            return { success: true, data: { revealed: true } };
        }
    };

    const provider = createGitSideProvider({
        electronAPI: mockAPI,
        uiHelper: { showToastNotification(msg, type) { toasts.push({ msg, type }); } }
    });

    const handle = await provider.mountTab({ id: 'side-pane-git', kind: 'git', title: 'Git 变更' }, viewElement);
    assert.ok(handle);

    // header: one source select + one refresh button, nothing else (single workspace => no workspace picker)
    assert.deepEqual([...viewElement.querySelectorAll('.side-git-source-select option')].map(o => o.value), ['unstaged', 'staged']);
    assert.equal(viewElement.querySelector('.side-git-ws-select').hidden, true);
    assert.match(viewElement.querySelector('.side-git-refresh-btn').textContent, /刷新/);
    for (const gone of ['.side-git-branch-badge', '.side-git-sync-badge', '.side-git-commit-input', '.side-git-group', '.side-git-row-action-btn', '.side-git-graph-btn']) {
        assert.equal(viewElement.querySelector(gone), null, gone + ' must not exist');
    }

    // flat list, default source = unstaged
    const cards = () => [...viewElement.querySelectorAll('.side-git-card')];
    assert.deepEqual(cards().map(c => c.dataset.path), ['src/unstaged.js', 'notes.txt']);
    assert.equal(cards()[0].querySelector('.side-git-file-name').textContent, 'unstaged.js');
    assert.equal(cards()[0].querySelector('.side-git-file-dir').textContent, 'src');

    // +N -N are filled in without expanding
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cards()[0].querySelector('.text-diff-added').textContent, '+3');
    assert.equal(cards()[0].querySelector('.text-diff-removed').textContent, '-1');

    // expand
    const row = cards()[0].querySelector('.side-git-row');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    row.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, false);
    assert.ok(cards()[0].querySelector('.side-git-diff-table'));
    row.click();
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, true);

    // staged source
    const select = viewElement.querySelector('.side-git-source-select');
    select.value = 'staged';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(cards().map(c => c.dataset.path), ['src/staged.js']);

    // context menu: reveal / copy absolute / copy relative
    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const items = [...doc.querySelectorAll('.side-git-context-item')];
    assert.deepEqual(items.map(i => i.querySelector('.side-git-context-label').textContent), ['在文件管理器中打开', '复制绝对路径', '复制相对路径']);
    items[2].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(copied, ['src/staged.js']);
    assert.equal(doc.querySelector('.side-git-context-menu'), null, 'menu closes after choosing');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    [...doc.querySelectorAll('.side-git-context-item')][1].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(copied[1], '/code/vcpchat/src/staged.js');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    [...doc.querySelectorAll('.side-git-context-item')][0].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(revealed, [['ws-demo', 'src/staged.js']]);

    await handle.dispose();
});


test('SidePaneController: header toggle opens the launcher when side chat is disabled', async () => {
    const dom = new JSDOM(`
        <button id="toggleSidePaneChatBtn" type="button"></button>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher"></section>
            </div>
        </aside>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');

    const controller = createSidePaneController({
        root,
        toggleChatBtn: toggleBtn,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers: {}
    });

    toggleBtn.click();
    const opened = controller.getSnapshot();
    assert.equal(opened.visible, true);
    assert.equal(opened.activeTabId, SidePaneState.LAUNCHER_TAB_ID);

    toggleBtn.click();
    assert.equal(controller.getSnapshot().visible, false);
});

test('CodeViewerSideProvider: menu-opened viewer browses workspace files with the real source API shapes', async () => {
    const dom = new JSDOM('<div id="host"></div>');
    const doc = dom.window.document;
    const viewElement = doc.getElementById('host');
    const reads = [];
    const api = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'ws1', alias: 'demo', path: '/demo' }], activeWorkspaceId: 'ws1' } };
        },
        async sourceListFiles(id) {
            assert.equal(id, 'ws1');
            return { success: true, data: { root: '/demo', files: ['README.md', 'src/app.js', 'logo.png'], truncated: false, limit: 5000 } };
        },
        async sourceReadFile(id, rel) {
            reads.push([id, rel]);
            if (rel === 'logo.png') return { success: true, data: { path: rel, binary: true, text: '' } };
            return { success: true, data: { path: rel, binary: false, text: 'const a = 1;\nconst b = 2;\n' } };
        }
    };
    const provider = createCodeViewerSideProvider({ document: doc, api, uiHelper: {} });
    const handle = await provider.mountTab({ id: 'side-pane-code-viewer', kind: 'code-viewer', title: '代码审阅', payload: {} }, viewElement);

    assert.equal(viewElement.querySelectorAll('.side-code-picker-item').length, 3);

    const filter = viewElement.querySelector('.side-code-picker-filter');
    filter.value = 'app';
    filter.dispatchEvent(new dom.window.Event('input'));
    assert.equal(viewElement.querySelectorAll('.side-code-picker-item').length, 1);

    viewElement.querySelector('.side-code-picker-item').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reads, [['ws1', 'src/app.js']]);
    assert.equal(handle.getCode(), 'const a = 1;\nconst b = 2;\n');
    assert.equal(viewElement.querySelector('.side-code-title').textContent, 'app.js');
    assert.equal(viewElement.querySelector('.side-code-lang-tag').textContent, 'JS');

    filter.value = 'logo';
    filter.dispatchEvent(new dom.window.Event('input'));
    viewElement.querySelector('.side-code-picker-item').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(viewElement.querySelector('.side-code-body').textContent, /二进制/);
    assert.equal(handle.getCode(), '');
    handle.dispose();
});

test('TerminalSideProvider: mirrors the shared terminal session, wires input/output, and only closes its own view on dispose', async () => {
    const dom = new JSDOM('<div id="host"></div>');
    const doc = dom.window.document;
    const viewElement = doc.getElementById('host');

    const calls = [];
    const listeners = {};
    const api = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'ws1', alias: 'demo', path: '/demo' }], activeWorkspaceId: 'ws1' } };
        },
        async terminalCreate(options) {
            calls.push(['create', options]);
            return { success: true, data: { id: 't1', pid: 1, shared: true } };
        },
        async terminalRestart(id) { calls.push(['restart', id]); return { success: true, data: { pid: 2 } }; },
        async terminalChangeDirectory(id, workspaceId) { calls.push(['cd', id, workspaceId]); return { success: true, data: { cwd: '/demo' } }; },
        terminalWrite(id, data) { calls.push(['write', id, data]); },
        terminalResize(id, cols, rows) { calls.push(['resize', id, cols, rows]); },
        async terminalKill(id) { calls.push(['kill', id]); return { success: true }; },
        onTerminalData(cb) { listeners.data = cb; return () => { listeners.data = null; }; },
        onTerminalClear(cb) { listeners.clear = cb; return () => { listeners.clear = null; }; },
        onTerminalExit(cb) { listeners.exit = cb; return () => { listeners.exit = null; }; }
    };

    const written = [];
    let onDataHandler = null;
    class FakeTerminal {
        constructor() { this.cols = 90; this.rows = 20; }
        loadAddon() {}
        open() {}
        onData(cb) { onDataHandler = cb; }
        onResize() {}
        write(text) { written.push(text); }
        reset() { written.push('<reset>'); }
        clear() {}
        focus() {}
        dispose() { this.disposed = true; }
    }
    const provider = createTerminalSideProvider({
        document: doc,
        api,
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null })
    });
    const handle = await provider.mountTab({ id: 'terminal:1', kind: 'terminal', title: '终端', payload: {} }, viewElement);

    // Attaches to the shared session (no per-tab shell / cwd of its own)
    assert.deepEqual(calls[0], ['create', {}]);
    assert.equal(viewElement.querySelector('.side-terminal-status').textContent, '已连接终端');
    assert.equal(handle.getSessionId(), 't1');

    // Workspaces are "jump to directory" shortcuts, then the select returns to its placeholder
    const wsSelect = viewElement.querySelector('.side-terminal-ws-select');
    assert.equal(wsSelect.disabled, false);
    wsSelect.value = 'ws1';
    wsSelect.dispatchEvent(new dom.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.at(-1), ['cd', 't1', 'ws1']);
    assert.equal(wsSelect.value, '');

    // Output for this session is written, output for other sessions is ignored
    listeners.data({ id: 't1', data: 'hello' });
    listeners.data({ id: 'other', data: 'nope' });
    assert.deepEqual(written, ['hello']);

    // Getting focus claims the shared PTY size for this view
    handle.focus();
    assert.deepEqual(calls.at(-1), ['resize', 't1', 90, 20]);

    // Keystrokes go to the session
    onDataHandler('ls\r');
    assert.ok(calls.some((c) => c[0] === 'write' && c[1] === 't1' && c[2] === 'ls\r'));

    // The shared session being reset clears the screen
    listeners.clear({ id: 't1' });
    assert.equal(written.at(-1), '<reset>');

    // Exit is reported; the view stays attached so a restart brings the shell back
    listeners.exit({ id: 't1', exitCode: 3 });
    assert.match(written.at(-1), /3/);
    assert.equal(viewElement.querySelector('.side-terminal-status').textContent, '已退出');
    dom.window.confirm = () => false;
    viewElement.querySelector('.side-terminal-btn[aria-label="重新启动终端"]').click();
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(calls.some(c => c[0] === 'restart'),false,'cancel preserves the shared shell');
    dom.window.confirm = () => true;
    viewElement.querySelector('.side-terminal-btn[aria-label="重新启动终端"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((c) => c[0] === 'restart' && c[1] === 't1'));
    assert.equal(viewElement.querySelector('.side-terminal-status').textContent, '已连接终端');

    handle.dispose();
    assert.equal(listeners.data, null);
    assert.equal(listeners.clear, null);
    // Disposing closes only this view (terminalKill = detach), it never restarts the shared shell
    assert.deepEqual(calls.at(-1), ['kill', 't1']);
});

test('TerminalSideProvider: shows an error instead of a dead terminal when the shell cannot start', async () => {
    const dom = new JSDOM('<div id="host"></div>');
    const doc = dom.window.document;
    const viewElement = doc.getElementById('host');
    const written = [];
    class FakeTerminal {
        constructor() { this.cols = 80; this.rows = 24; }
        loadAddon() {} open() {} onData() {} onResize() {} reset() {} clear() {} focus() {} dispose() {}
        write(text) { written.push(text); }
    }
    const provider = createTerminalSideProvider({
        document: doc,
        api: {
            async gitListWorkspaces() { return { success: true, data: { workspaces: [], activeWorkspaceId: null } }; },
            async terminalCreate() { return { success: false, error: '终端数量已达上限' }; },
            onTerminalData() { return () => {}; },
            onTerminalClear() { return () => {}; },
            onTerminalExit() { return () => {}; }
        },
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null })
    });
    await provider.mountTab({ id: 'terminal:3', kind: 'terminal', title: '终端', payload: {} }, viewElement);
    const status = viewElement.querySelector('.side-terminal-status');
    assert.equal(status.textContent, '终端数量已达上限');
    assert.ok(status.classList.contains('is-error'));
    assert.ok(written.some((w) => w.includes('终端数量已达上限')));
});

test('normalizeBrowserInput: fills in schemes and refuses unsafe protocols', () => {
    assert.equal(normalizeBrowserInput('   '), null);
    assert.equal(normalizeBrowserInput('example.com/a?b=1').url, 'https://example.com/a?b=1');
    assert.equal(normalizeBrowserInput('localhost:3000').url, 'http://localhost:3000/');
    assert.equal(normalizeBrowserInput('192.168.1.5:8080/x').url, 'http://192.168.1.5:8080/x');
    assert.equal(normalizeBrowserInput('http://a.example').url, 'http://a.example/');
    assert.equal(normalizeBrowserInput('about:blank').url, 'about:blank');
    for (const bad of ['javascript:alert(1)', 'vcp://x', 'ftp://a.example', 'two words', 'intranet']) {
        assert.ok(normalizeBrowserInput(bad).error, bad);
    }
});

test('BrowserSideProvider: isolated webview, address bar navigation and popup routing', async () => {
    const dom = new JSDOM('<div id="host"></div>');
    const doc = dom.window.document;
    const viewElement = doc.getElementById('host');
    const realCreate = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
        const node = realCreate(tag);
        if (tag === 'webview') {
            Object.assign(node, {
                loadURL: async () => {}, canGoBack: () => false, canGoForward: () => false,
                getURL: () => node.getAttribute('src'), getTitle: () => '', stop() {}, reload() {}, goBack() {}, goForward() {}, openDevTools() {}
            });
        }
        return node;
    };

    const opened = [];
    let tabListener = null;
    const sidePaneController = {
        async openTab(tab) { opened.push(tab); return { focus() {} }; },
        setVisible() {}
    };
    const provider = createBrowserSideProvider({
        document: doc,
        api: { onBrowserOpenTab(cb) { tabListener = cb; return () => { tabListener = null; }; } },
        sidePaneController
    });
    const handle = await provider.mountTab({ id: 'browser:0', kind: 'browser', title: '浏览器', payload: {} }, viewElement);
    assert.equal(viewElement.querySelector('webview'), null, 'the guest is only created on the first navigation');

    const address = viewElement.querySelector('.side-browser-address');
    address.value = 'javascript:alert(1)';
    address.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(viewElement.querySelector('webview'), null);

    address.value = 'localhost:3000';
    address.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const webview = viewElement.querySelector('webview');
    assert.ok(webview);
    assert.equal(webview.getAttribute('partition'), BROWSER_PARTITION);
    assert.equal(webview.getAttribute('src'), 'http://localhost:3000/');
    assert.equal(webview.hasAttribute('preload'), false);

    // a popup from the page becomes a new side-pane tab; a blank tab is reused instead of piling up
    tabListener({ url: 'https://a.example/x' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(opened.at(-1).kind, 'browser');
    assert.deepEqual(opened.at(-1).payload, { url: 'https://a.example/x' });
    assert.notEqual(opened.at(-1).id, 'browser:0');

    handle.dispose();
    assert.equal(tabListener, null);
});
