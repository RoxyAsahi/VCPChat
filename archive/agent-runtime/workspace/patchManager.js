'use strict';

const path = require('path');
const crypto = require('crypto');
const { ERROR_CODES, fail } = require('../errors');
const { canonicalizeWorkspaceRoot, resolveInsideRoot } = require('../workspacePolicy');

const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const VCP_LITERAL_REPLACEMENTS = Object.freeze([
    ['<<<[TOOL_REQUEST]>>>', '<<<[TOOL_REQUEST_ESCAPE]>>>'],
    ['<<<[END_TOOL_REQUEST]>>>', '<<<[END_TOOL_REQUEST_ESCAPE]>>>'],
    ['「始」', '「始ESCAPE」'],
    ['「末」', '「末ESCAPE」'],
]);

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

const EMPTY_HASH = sha256(Buffer.alloc(0));

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function splitLines(content) {
    if (content === '') return [];
    const lines = content.match(/.*(?:\n|$)/g) || [];
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function lineDiff(before, after) {
    const left = splitLines(before);
    const right = splitLines(after);
    const cells = (left.length + 1) * (right.length + 1);
    if (cells > 4_000_000) {
        return [
            ...left.map((line) => ({ type: '-', line })),
            ...right.map((line) => ({ type: '+', line })),
        ];
    }
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i -= 1) {
        for (let j = right.length - 1; j >= 0; j -= 1) {
            table[i][j] = left[i] === right[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const output = [];
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) {
            output.push({ type: ' ', line: left[i] });
            i += 1;
            j += 1;
        } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
            output.push({ type: '+', line: right[j] });
            j += 1;
        } else {
            output.push({ type: '-', line: left[i] });
            i += 1;
        }
    }
    return output;
}

function unifiedDiff(relativePath, before, after) {
    if (before === after) return '';
    const oldLines = splitLines(before).length;
    const newLines = splitLines(after).length;
    const body = lineDiff(before, after).map(({ type, line }) => `${type}${line}`).join('');
    return `--- a/${relativePath}\n+++ b/${relativePath}\n@@ -${oldLines === 0 ? 0 : 1},${oldLines} +${newLines === 0 ? 0 : 1},${newLines} @@\n${body}`;
}

function normalizeRelativePath(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail(ERROR_CODES.WORKSPACE_INVALID, 'Patch path must be a non-empty relative path');
    }
    if (value.includes('\0')) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT, 'Patch path contains a NUL byte');
    }
    const raw = value.trim();
    if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || raw.startsWith('\\\\')) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT, `Absolute patch paths are forbidden: ${value}`);
    }
    const normalized = raw.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
    if (normalized.some((part) => part === '..')) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT, `Parent traversal is forbidden: ${value}`);
    }
    if (normalized.length === 0) {
        fail(ERROR_CODES.WORKSPACE_INVALID, 'Patch path must name a file');
    }
    return normalized.join('/');
}

function escapeVcpLiterals(content) {
    let escaped = content;
    for (const [literal, replacement] of VCP_LITERAL_REPLACEMENTS) {
        escaped = escaped.split(literal).join(replacement);
    }
    return { content: escaped, changed: escaped !== content };
}

function getResultDetails(result) {
    const raw = result && result.raw;
    return raw?.result?.details
        || raw?.details
        || raw?.data
        || raw?.result?.data
        || null;
}

function extractReadContent(result) {
    const details = getResultDetails(result);
    const content = details && details.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const textParts = content.filter((part) => part && part.type === 'text').map((part) => String(part.text || ''));
        if (textParts.length >= 2) return textParts.slice(1).join('\n');
        if (textParts.length === 1) return textParts[0];
    }
    fail(ERROR_CODES.WORKSPACE_INVALID, 'FileOperator returned no editable text content');
}

function isMissingFileError(message) {
    return /ENOENT|no such file|file not found|cannot find the (?:file|path)|找不到|不存在/i.test(String(message || ''));
}

function publicProposal(record) {
    return {
        proposalId: record.proposalId,
        path: record.path,
        state: record.state,
        beforeHash: record.beforeHash,
        beforeContent: record.beforeContent,
        afterHash: record.afterHash,
        afterContent: record.afterContent,
        diff: record.diff,
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        rejectedAt: record.rejectedAt,
        revertedAt: record.revertedAt,
    };
}

class PatchManager {
    constructor(options = {}) {
        if (typeof options.invokeTool !== 'function') {
            throw new TypeError('PatchManager requires invokeTool');
        }
        this.workspaceRoot = canonicalizeWorkspaceRoot(options.workspaceRoot);
        this.invokeTool = options.invokeTool;
        this.maxPatchBytes = options.maxPatchBytes || DEFAULT_MAX_PATCH_BYTES;
        this.proposals = new Map();
    }

    async propose(relativePath, afterContent) {
        if (typeof afterContent !== 'string') fail(ERROR_CODES.WORKSPACE_INVALID, 'Patch content must be text');
        if (Buffer.byteLength(afterContent) > this.maxPatchBytes) fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Patch content exceeds limit');
        const target = this._target(relativePath);
        const before = await this._readState(target.absolutePath);
        const record = {
            proposalId: makeId('patch'),
            path: target.relativePath,
            state: 'proposed',
            existed: before.existed,
            beforeContent: before.content,
            beforeHash: sha256(Buffer.from(before.content)),
            afterContent,
            afterHash: sha256(Buffer.from(afterContent)),
            diff: unifiedDiff(target.relativePath, before.content, afterContent),
            createdAt: Date.now(),
        };
        this.proposals.set(record.proposalId, record);
        return publicProposal(record);
    }

    get(proposalId) {
        const record = this.proposals.get(proposalId);
        if (!record) fail(ERROR_CODES.WORKSPACE_INVALID, `Patch proposal not found: ${proposalId}`);
        return publicProposal(record);
    }

    list() {
        return Array.from(this.proposals.values())
            .sort((left, right) => right.createdAt - left.createdAt)
            .map(publicProposal);
    }

    reject(proposalId) {
        const record = this._pending(proposalId);
        record.state = 'rejected';
        record.rejectedAt = Date.now();
        return publicProposal(record);
    }

    async apply(proposalId, options = {}) {
        const record = this._pending(proposalId);
        if (options.approved !== true) fail(ERROR_CODES.APPROVAL_DENIED, 'Patch apply requires explicit approval');
        const target = this._target(record.path);
        await this._assertCurrentState(record, target.absolutePath, 'before');
        await this._writeExact(target.absolutePath, record.afterContent, record.existed);
        await this._assertCurrentState(record, target.absolutePath, 'after');
        record.state = 'applied';
        record.appliedAt = Date.now();
        return publicProposal(record);
    }

    async revert(proposalId, options = {}) {
        const record = this.proposals.get(proposalId);
        if (!record || record.state !== 'applied') fail(ERROR_CODES.WORKSPACE_INVALID, `Patch is not applied: ${proposalId}`);
        if (options.approved !== true) fail(ERROR_CODES.APPROVAL_DENIED, 'Patch revert requires explicit approval');
        const target = this._target(record.path);
        await this._assertCurrentState(record, target.absolutePath, 'after');
        if (record.existed) {
            await this._writeExact(target.absolutePath, record.beforeContent, true);
        } else {
            await this._invokeFileOperator({ command: 'DeleteFile', filePath: target.absolutePath });
        }
        await this._assertCurrentState(record, target.absolutePath, 'before');
        record.state = 'reverted';
        record.revertedAt = Date.now();
        return publicProposal(record);
    }

    _target(relativePath) {
        const normalized = normalizeRelativePath(relativePath);
        return {
            relativePath: normalized,
            absolutePath: resolveInsideRoot(this.workspaceRoot, normalized),
        };
    }

    async _readState(absolutePath) {
        const result = await this.invokeTool({
            toolName: 'FileOperator',
            args: { command: 'ReadFile', filePath: absolutePath, encoding: 'utf8' },
        });
        if (!result || result.ok !== true) {
            if (isMissingFileError(result && result.error)) return { existed: false, content: '' };
            fail(ERROR_CODES.TOOLBOX_REQUEST_FAILED, `FileOperator ReadFile failed: ${result?.error || 'unknown error'}`);
        }
        const content = extractReadContent(result);
        if (Buffer.byteLength(content) > this.maxPatchBytes) {
            fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Patch source exceeds limit');
        }
        return { existed: true, content };
    }

    async _assertCurrentState(record, absolutePath, phase) {
        const current = await this._readState(absolutePath);
        const expectedExisted = phase === 'before' ? record.existed : true;
        const expectedHash = phase === 'before' ? record.beforeHash : record.afterHash;
        const actualHash = sha256(Buffer.from(current.content));
        if (current.existed !== expectedExisted || actualHash !== expectedHash) {
            fail(ERROR_CODES.WORKSPACE_INVALID,
                phase === 'before' ? 'Patch base changed after proposal (TOCTOU)' : 'FileOperator write verification failed',
                { expectedHash, actualHash, expectedExisted, actualExisted: current.existed });
        }
    }

    async _writeExact(absolutePath, content, existed) {
        const escaped = escapeVcpLiterals(content);
        const command = existed
            ? (escaped.changed ? 'EditEscapedFile' : 'EditFile')
            : (escaped.changed ? 'WriteEscapedFile' : 'WriteFile');
        await this._invokeFileOperator({
            command,
            filePath: absolutePath,
            content: escaped.content,
            encoding: 'utf8',
        });
    }

    async _invokeFileOperator(args) {
        const result = await this.invokeTool({ toolName: 'FileOperator', args });
        if (!result || result.ok !== true) {
            fail(ERROR_CODES.TOOLBOX_REQUEST_FAILED,
                `FileOperator ${args.command} failed: ${result?.error || 'unknown error'}`);
        }
        return result;
    }

    _pending(proposalId) {
        const record = this.proposals.get(proposalId);
        if (!record || record.state !== 'proposed') fail(ERROR_CODES.WORKSPACE_INVALID, `Patch is not pending: ${proposalId}`);
        return record;
    }
}

module.exports = {
    PatchManager,
    unifiedDiff,
    normalizeRelativePath,
    escapeVcpLiterals,
    extractReadContent,
    EMPTY_HASH,
};
