import assert from 'node:assert/strict';
import { createWorkspacePathRef, createWorkspaceTreeModel, sortWorkspaceEntries, structuredWorkspacePaths } from '../modules/ui-system/agent-workspace-model.js';

assert.deepEqual(sortWorkspaceEntries([
    { name: 'z.js', kind: 'file' },
    { name: 'beta', kind: 'directory' },
    { name: 'Alpha', kind: 'directory' },
]).map((entry) => entry.name), ['Alpha', 'beta', 'z.js']);

const model = createWorkspaceTreeModel();
model.reset('session-a:revision-a');
model.setChildren('', [{ name: 'src', kind: 'directory', relativePath: 'src' }, { name: 'README.md', kind: 'file', relativePath: 'README.md' }]);
model.setChildren('src', [{ name: 'index.js', kind: 'file', relativePath: 'src/index.js' }]);
assert.deepEqual(model.flatten().map((row) => row.entry.relativePath), ['src', 'README.md']);
model.setExpanded('src', true);
assert.deepEqual(model.flatten().map((row) => row.entry.relativePath), ['src', 'src/index.js', 'README.md']);
assert.deepEqual(model.flatten().map((row) => row.depth), [0, 1, 0]);

let parent = '';
for (let index = 0; index < 5000; index += 1) {
    const next = parent ? `${parent}/d` : 'd';
    model.setChildren(parent, [{ name: 'd', kind: 'directory', relativePath: next }]);
    model.setExpanded(next, true);
    parent = next;
}
assert.equal(model.flatten().length, 5000);

assert.deepEqual(createWorkspacePathRef({
    sessionId: 'session-a', workspaceRevision: 'revision-a', relativePath: 'src\\index.js', source: 'diff',
}), {
    sessionId: 'session-a', workspaceRevision: 'revision-a', relativePath: 'src/index.js', kind: 'file', source: 'diff',
});
assert.throws(() => createWorkspacePathRef({ sessionId: 'a', workspaceRevision: 'b', relativePath: '../x' }), /safe relative path/);
assert.throws(() => createWorkspacePathRef({ sessionId: 'a', workspaceRevision: 'b', relativePath: 'C:\\x' }), /safe relative path/);

assert.deepEqual(structuredWorkspacePaths({
    arguments: { path: 'src/index.js', nested: { targetPath: 'README.md' } },
    output: { path: 'C:\\Windows\\secret.txt', uri: 'file:///tmp/x' },
}), ['src/index.js', 'README.md']);

console.log('Agent workspace model tests passed.');
