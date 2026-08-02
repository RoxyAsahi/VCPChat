'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { canonicalizeWorkspaceRoot, resolveInsideRoot } = require('../agent-runtime/workspacePolicy');

const DEFAULT_LIMITS = Object.freeze({
    maxDirectoryEntries: 1000,
    maxPreviewBytes: 1024 * 1024,
    maxImageBytes: 4 * 1024 * 1024,
    maxSearchResults: 200,
    maxSearchEntries: 20_000,
    operationTimeoutMs: 10_000,
});

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.mdx', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env',
    '.py', '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.ps1',
    '.bat', '.cmd', '.sql', '.graphql', '.vue', '.svelte', '.log', '.csv', '.tsv', '.gitignore',
]);
const IMAGE_MIME = Object.freeze({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
});
const MEDIA_MIME = Object.freeze({
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
});
const RISKY_EXTENSIONS = new Set(['.exe', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr', '.vbs', '.js', '.jse', '.wsf', '.reg']);

function workspaceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeRelativePath(value, { allowEmpty = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (allowEmpty) return '';
        throw workspaceError('WORKSPACE_PATH_REQUIRED', 'Workspace path is required');
    }
    if (typeof value !== 'string' || value.includes('\0')) {
        throw workspaceError('WORKSPACE_PATH_INVALID', 'Workspace path must be a valid string');
    }
    const slash = value.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(slash) || slash.startsWith('/') || slash.startsWith('//') || /^\\\\[.?]\\/.test(value)) {
        throw workspaceError('WORKSPACE_PATH_ABSOLUTE', 'Absolute and device paths are not allowed');
    }
    const parts = slash.split('/').filter((part) => part && part !== '.');
    if (parts.some((part) => part === '..')) {
        throw workspaceError('WORKSPACE_PATH_TRAVERSAL', 'Workspace path traversal is not allowed');
    }
    const normalized = parts.join('/');
    if (!normalized && !allowEmpty) throw workspaceError('WORKSPACE_PATH_REQUIRED', 'Workspace path is required');
    return normalized;
}

function relativeFromRoot(root, absolutePath) {
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

function revisionForRoot(root) {
    return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function withTimeout(promise, timeoutMs) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(workspaceError('WORKSPACE_TIMEOUT', 'Workspace operation timed out')), timeoutMs);
            timer.unref?.();
        }),
    ]).finally(() => clearTimeout(timer));
}

class AgentWorkspaceService {
    constructor(options = {}) {
        if (typeof options.getSession !== 'function') throw new TypeError('getSession is required');
        this.getSession = options.getSession;
        this.shell = options.shell || null;
        this.clipboard = options.clipboard || null;
        this.confirmOpen = options.confirmOpen || (async () => false);
        this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    }

    _context(payload = {}) {
        const sessionId = String(payload.sessionId || '').trim();
        if (!sessionId) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 'Agent Session is required');
        const session = this.getSession(sessionId);
        if (!session) throw workspaceError('WORKSPACE_SESSION_NOT_FOUND', 'Agent Session was not found');
        const root = canonicalizeWorkspaceRoot(session.workspaceRoot);
        const workspaceRevision = revisionForRoot(root);
        if (payload.workspaceRevision && payload.workspaceRevision !== workspaceRevision) {
            throw workspaceError('WORKSPACE_STALE', 'Workspace reference is stale');
        }
        const relativePath = normalizeRelativePath(payload.relativePath || '');
        const absolutePath = relativePath ? resolveInsideRoot(root, relativePath) : root;
        return { sessionId, session, root, workspaceRevision, relativePath, absolutePath };
    }

    async listDirectory(payload = {}) {
        return withTimeout(this._listDirectory(payload), this.limits.operationTimeoutMs);
    }

    async _listDirectory(payload) {
        const context = this._context(payload);
        const stat = await fs.promises.stat(context.absolutePath);
        if (!stat.isDirectory()) throw workspaceError('WORKSPACE_NOT_DIRECTORY', 'Workspace path is not a directory');
        const offset = Math.max(0, Number.parseInt(payload.cursor || '0', 10) || 0);
        const requestedLimit = Number(payload.limit) || this.limits.maxDirectoryEntries;
        const limit = Math.min(Math.max(1, requestedLimit), this.limits.maxDirectoryEntries);
        const dirents = await fs.promises.readdir(context.absolutePath, { withFileTypes: true });
        const entries = dirents.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
            relativePath: normalizeRelativePath([context.relativePath, entry.name].filter(Boolean).join('/'), { allowEmpty: false }),
        })).sort((a, b) => {
            const rank = (value) => value.kind === 'directory' ? 0 : 1;
            return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        const page = entries.slice(offset, offset + limit);
        return {
            sessionId: context.sessionId,
            workspaceRevision: context.workspaceRevision,
            relativePath: context.relativePath,
            entries: page,
            nextCursor: offset + page.length < entries.length ? String(offset + page.length) : null,
            truncated: entries.length > offset + page.length,
        };
    }

    async statPath(payload = {}) {
        const context = this._context(payload);
        const stat = await fs.promises.stat(context.absolutePath);
        return {
            sessionId: context.sessionId,
            workspaceRevision: context.workspaceRevision,
            relativePath: context.relativePath,
            kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
            byteLen: stat.size,
            modifiedAt: stat.mtime.toISOString(),
        };
    }

    async readPreview(payload = {}) {
        return withTimeout(this._readPreview(payload), this.limits.operationTimeoutMs);
    }

    async _readPreview(payload) {
        const context = this._context(payload);
        if (!context.relativePath) throw workspaceError('WORKSPACE_PATH_REQUIRED', 'Select a file to preview');
        const stat = await fs.promises.stat(context.absolutePath);
        if (!stat.isFile()) throw workspaceError('WORKSPACE_NOT_FILE', 'Workspace path is not a file');
        const extension = path.extname(context.absolutePath).toLowerCase();
        const base = {
            sessionId: context.sessionId,
            workspaceRevision: context.workspaceRevision,
            relativePath: context.relativePath,
            displayName: path.basename(context.absolutePath),
            byteLen: stat.size,
            modifiedAt: stat.mtime.toISOString(),
        };
        if (IMAGE_MIME[extension]) {
            if (stat.size > this.limits.maxImageBytes) return { ...base, kind: 'image', mimeType: IMAGE_MIME[extension], truncated: true };
            const buffer = await fs.promises.readFile(context.absolutePath);
            return { ...base, kind: 'image', mimeType: IMAGE_MIME[extension], dataUrl: `data:${IMAGE_MIME[extension]};base64,${buffer.toString('base64')}`, truncated: false };
        }
        if (MEDIA_MIME[extension]) return { ...base, kind: 'media', mimeType: MEDIA_MIME[extension] };
        const sampleSize = Math.min(stat.size, this.limits.maxPreviewBytes);
        const file = await fs.promises.open(context.absolutePath, 'r');
        let buffer;
        try {
            buffer = Buffer.alloc(sampleSize);
            const result = await file.read(buffer, 0, sampleSize, 0);
            buffer = buffer.subarray(0, result.bytesRead);
        } finally {
            await file.close();
        }
        const binary = buffer.includes(0) || (!TEXT_EXTENSIONS.has(extension) && invalidUtf8Ratio(buffer) > 0.02);
        if (binary) return { ...base, kind: 'binary', mimeType: 'application/octet-stream' };
        const content = buffer.toString('utf8');
        return {
            ...base,
            kind: 'text',
            encoding: 'utf-8',
            content,
            lineCount: content ? content.split(/\r?\n/).length : 0,
            truncated: stat.size > buffer.length,
        };
    }

    async searchFiles(payload = {}) {
        return withTimeout(this._searchFiles(payload), this.limits.operationTimeoutMs);
    }

    async _searchFiles(payload) {
        const context = this._context({ ...payload, relativePath: '' });
        const query = String(payload.query || '').trim().toLocaleLowerCase();
        if (!query) return { sessionId: context.sessionId, workspaceRevision: context.workspaceRevision, query, entries: [], truncated: false };
        const limit = Math.min(Math.max(1, Number(payload.limit) || 50), this.limits.maxSearchResults);
        const results = [];
        const queue = [context.root];
        let visited = 0;
        while (queue.length && results.length < limit && visited < this.limits.maxSearchEntries) {
            const directory = queue.shift();
            let entries;
            try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
            catch { continue; }
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            for (const entry of entries) {
                visited += 1;
                const absolute = path.join(directory, entry.name);
                const relativePath = relativeFromRoot(context.root, absolute);
                if (entry.isDirectory()) queue.push(absolute);
                if (relativePath.toLocaleLowerCase().includes(query)) {
                    results.push({ name: entry.name, relativePath, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
                    if (results.length >= limit) break;
                }
                if (visited >= this.limits.maxSearchEntries) break;
            }
        }
        return {
            sessionId: context.sessionId,
            workspaceRevision: context.workspaceRevision,
            query,
            entries: results,
            truncated: results.length >= limit || visited >= this.limits.maxSearchEntries,
        };
    }

    async performPathAction(payload = {}) {
        const context = this._context(payload);
        if (!context.relativePath) throw workspaceError('WORKSPACE_PATH_REQUIRED', 'Select a workspace path');
        const action = String(payload.action || '');
        if (action === 'preview' || action === 'open-in-vchat') return this.readPreview(payload);
        if (action === 'copy-relative-path') {
            this.clipboard?.writeText(context.relativePath);
            return { ok: true, action, value: context.relativePath };
        }
        if (action === 'copy-absolute-path') {
            this.clipboard?.writeText(context.absolutePath);
            return { ok: true, action };
        }
        if (action === 'reveal-in-explorer') {
            if (!this.shell?.showItemInFolder) throw workspaceError('WORKSPACE_ACTION_UNAVAILABLE', 'Reveal action is unavailable');
            this.shell.showItemInFolder(context.absolutePath);
            return { ok: true, action };
        }
        if (action === 'open-with-system') {
            if (!this.shell?.openPath) throw workspaceError('WORKSPACE_ACTION_UNAVAILABLE', 'System open action is unavailable');
            if (RISKY_EXTENSIONS.has(path.extname(context.absolutePath).toLowerCase())) {
                const approved = await this.confirmOpen({ sessionId: context.sessionId, relativePath: context.relativePath });
                if (!approved) throw workspaceError('WORKSPACE_ACTION_CANCELLED', 'System open was cancelled');
            }
            const error = await this.shell.openPath(context.absolutePath);
            if (error) throw workspaceError('WORKSPACE_ACTION_FAILED', error);
            return { ok: true, action };
        }
        throw workspaceError('WORKSPACE_ACTION_UNSUPPORTED', `Unsupported workspace action: ${action}`);
    }
}

function invalidUtf8Ratio(buffer) {
    if (!buffer.length) return 0;
    const decoded = buffer.toString('utf8');
    const replacements = [...decoded].filter((character) => character === '\uFFFD').length;
    return replacements / Math.max(1, decoded.length);
}

module.exports = {
    AgentWorkspaceService,
    DEFAULT_LIMITS,
    normalizeRelativePath,
    revisionForRoot,
};
