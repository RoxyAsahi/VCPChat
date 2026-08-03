import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PatchManager } = require('../archive/agent-runtime/workspace/patchManager.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-diff-vcp-'));
const files = new Map([[path.join(root, 'file.txt'), 'before\n']]);
const calls = [];

function restoreEscaped(content) {
    return String(content)
        .replaceAll('「始ESCAPE」', '「始」')
        .replaceAll('「末ESCAPE」', '「末」')
        .replaceAll('<<<[TOOL_REQUEST_ESCAPE]>>>', '<<<[TOOL_REQUEST]>>>')
        .replaceAll('<<<[END_TOOL_REQUEST_ESCAPE]>>>', '<<<[END_TOOL_REQUEST]>>>');
}

async function invokeTool({ toolName, args }) {
    assert.equal(toolName, 'FileOperator');
    calls.push({ ...args });
    const target = path.resolve(args.filePath);
    if (args.command === 'ReadFile') {
        if (!files.has(target)) return { ok: false, error: `ENOENT: ${target}` };
        const content = files.get(target);
        return {
            ok: true,
            output: content,
            raw: { status: 'success', result: { details: { content: [
                { type: 'text', text: `read ${target}` },
                { type: 'text', text: content },
            ] } } },
        };
    }
    if (args.command === 'WriteFile' || args.command === 'WriteEscapedFile') {
        if (files.has(target)) return { ok: false, error: 'target already exists' };
        files.set(target, args.command === 'WriteEscapedFile' ? restoreEscaped(args.content) : args.content);
        return { ok: true, raw: { status: 'success', result: { details: { path: target, renamed: false } } } };
    }
    if (args.command === 'EditFile' || args.command === 'EditEscapedFile') {
        if (!files.has(target)) return { ok: false, error: `File not found: ${target}` };
        files.set(target, args.command === 'EditEscapedFile' ? restoreEscaped(args.content) : args.content);
        return { ok: true, raw: { status: 'success', result: { details: { path: target } } } };
    }
    if (args.command === 'DeleteFile') {
        files.delete(target);
        return { ok: true, raw: { status: 'success' } };
    }
    return { ok: false, error: `unsupported command ${args.command}` };
}

try {
    const patches = new PatchManager({ workspaceRoot: root, invokeTool });

    const proposal = await patches.propose('file.txt', 'after\n');
    assert.equal(files.get(path.join(root, 'file.txt')), 'before\n', 'propose must not write');
    assert.match(proposal.diff, /^--- a\/file\.txt/m);
    assert.match(proposal.diff, /-before/);
    assert.match(proposal.diff, /\+after/);
    await assert.rejects(() => patches.apply(proposal.proposalId), /approval/);

    files.set(path.join(root, 'file.txt'), 'attacker won TOCTOU\n');
    await assert.rejects(() => patches.apply(proposal.proposalId, { approved: true }), /TOCTOU/);
    files.set(path.join(root, 'file.txt'), 'before\n');
    await patches.apply(proposal.proposalId, { approved: true });
    assert.equal(files.get(path.join(root, 'file.txt')), 'after\n');
    await patches.revert(proposal.proposalId, { approved: true });
    assert.equal(files.get(path.join(root, 'file.txt')), 'before\n');

    const markerContent = '<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」\n<<<[END_TOOL_REQUEST]>>>';
    const created = await patches.propose('new.txt', markerContent);
    await patches.apply(created.proposalId, { approved: true });
    assert.equal(files.get(path.join(root, 'new.txt')), markerContent);
    assert.equal(calls.some((call) => call.command === 'WriteEscapedFile'), true);
    await patches.revert(created.proposalId, { approved: true });
    assert.equal(files.has(path.join(root, 'new.txt')), false);

    const rejected = await patches.propose('file.txt', 'never\n');
    assert.equal(patches.reject(rejected.proposalId).state, 'rejected');
    await assert.rejects(() => patches.apply(rejected.proposalId, { approved: true }), /not pending/);
    await assert.rejects(() => patches.propose('../outside.txt', 'x'), /traversal|escapes/i);

    console.log('Agent VCP-backed patch workflow and TOCTOU tests passed.');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
