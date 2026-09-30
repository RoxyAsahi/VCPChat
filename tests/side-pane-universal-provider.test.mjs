import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { createNotesSideProvider } from '../modules/ui-system/side-pane/notesSideProvider.js';
import { createCodeViewerSideProvider, computeLineDiff, detectLanguage } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import { createGitSideProvider } from '../modules/ui-system/side-pane/gitSideProvider.js';

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
            <div class="message assistant">
                <div class="message-content">这是 AI 提供的核心架构解答方案。</div>
            </div>
        </div>
        <textarea id="messageInput"></textarea>
        <div id="notesContainer"></div>
    `);
    const doc = dom.window.document;
    const viewElement = doc.getElementById('notesContainer');
    const messageInput = doc.getElementById('messageInput');

    const savedNotes = [];
    const mockElectronAPI = {
        async readNotesTree() {
            return [
                { type: 'file', name: '项目备忘.md', path: '/notes/项目备忘.md' },
                { type: 'file', name: '临时思路.txt', path: '/notes/临时思路.txt' }
            ];
        },
        async saveMiniNote(noteData) {
            savedNotes.push({ ...noteData });
            return { success: true, path: noteData.filePath || '/notes/new.md' };
        },
        async copyNoteContent(path) {
            return `# 这是${path}的内容`;
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
    assert.equal(select.options.length, 3); // __new__, 项目备忘, 临时思路

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

test('GitSideProvider: mounts workspace git panel, displays branch/sync and file groups, performs stage/unstage/commit and chat insertion', async () => {
    const dom = new JSDOM(`
        <div id="sideGitHost"></div>
        <textarea id="messageInput"></textarea>
    `);
    const doc = dom.window.document;
    const viewElement = doc.getElementById('sideGitHost');
    const messageInput = doc.getElementById('messageInput');

    const stagedChanges = [{ path: 'src/staged.js', status: 'M' }];
    const unstagedChanges = [{ path: 'src/unstaged.js', status: 'M' }, { path: 'notes.txt', status: 'U' }];
    let commitCount = 0;
    let pushCount = 0;
    const toasts = [];

    const mockAPI = {
        async gitListWorkspaces() {
            return {
                success: true,
                data: [{ id: 'ws-demo', alias: 'VCPChat-Core', path: '/code/vcpchat' }]
            };
        },
        async gitStatus(wsId) {
            return {
                success: true,
                data: {
                    isRepo: true,
                    branch: 'feat/v-forge-sync',
                    ahead: 2,
                    behind: 0,
                    staged: [...stagedChanges],
                    changes: [...unstagedChanges],
                    conflicts: []
                }
            };
        },
        async gitDiff(wsId, relPath, { staged }) {
            return {
                success: true,
                data: {
                    before: 'function hello() {}\n',
                    after: 'function hello() {\n    return 42;\n}\n',
                    rawDiff: '+ return 42;\n',
                    isBinary: false
                }
            };
        },
        async gitStage(wsId, paths) {
            return { success: true };
        },
        async gitUnstage(wsId, paths) {
            return { success: true };
        },
        async gitDiscard(wsId, paths) {
            return { success: true };
        },
        async gitCommit(wsId, payload) {
            commitCount++;
            return { success: true };
        },
        async gitPush(wsId, payload) {
            pushCount++;
            return { success: true };
        }
    };

    const uiHelper = {
        showToastNotification(msg, type) {
            toasts.push({ msg, type });
        }
    };

    const provider = createGitSideProvider({
        electronAPI: mockAPI,
        uiHelper
    });

    const handle = await provider.mountTab({
        id: 'side-pane-git',
        kind: 'git',
        title: 'Git 变更'
    }, viewElement);

    assert.ok(handle);

    // Verify workspace select & branch badge
    const wsSelect = viewElement.querySelector('.side-git-ws-select');
    assert.ok(wsSelect);
    assert.equal(wsSelect.value, 'ws-demo');

    const branchName = viewElement.querySelector('.side-git-branch-badge .branch-name');
    assert.ok(branchName);
    assert.equal(branchName.textContent, 'feat/v-forge-sync');

    const syncBadge = viewElement.querySelector('.side-git-sync-badge');
    assert.ok(syncBadge);
    assert.equal(syncBadge.textContent, '↑2 ↓0');

    // Verify change groups
    const stagedGroup = viewElement.querySelector('.side-git-group.group-staged');
    assert.ok(stagedGroup);
    assert.equal(stagedGroup.querySelectorAll('.side-git-file-item').length, 1);

    const unstagedGroup = viewElement.querySelector('.side-git-group.group-changes');
    assert.ok(unstagedGroup);
    assert.equal(unstagedGroup.querySelectorAll('.side-git-file-item').length, 2);

    // Test toggle inline diff on clicking row
    const stagedRow = stagedGroup.querySelector('.side-git-file-row');
    assert.ok(stagedRow);
    stagedRow.click();

    // Allow promise tick for gitDiff
    await new Promise(resolve => setTimeout(resolve, 20));
    const inlineDiff = stagedGroup.querySelector('.side-git-inline-diff');
    assert.ok(inlineDiff);
    assert.equal(inlineDiff.style.display, 'block');
    assert.ok(inlineDiff.querySelector('.side-git-diff-table'));

    // Test chat reference button
    const citeBtn = stagedGroup.querySelector('.side-git-row-action-btn[title*="引用"]');
    assert.ok(citeBtn);
    citeBtn.click();

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messageInput.value.includes('工作区文件改动: src/staged.js'), true);
    assert.equal(toasts.some(t => t.msg.includes('改动代码引用填入输入框')), true);

    // Test commit button
    const commitInput = viewElement.querySelector('.side-git-commit-input');
    const commitBtn = viewElement.querySelector('.side-git-commit-actions .side-git-btn.primary');
    assert.ok(commitInput);
    assert.ok(commitBtn);
    assert.equal(commitBtn.disabled, false); // Staged files exist

    commitInput.value = 'feat: integrate git into sidepane';
    commitBtn.click();

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(commitCount, 1);
    assert.equal(commitInput.value, ''); // cleared on success

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
