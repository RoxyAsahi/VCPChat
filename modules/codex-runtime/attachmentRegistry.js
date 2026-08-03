'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 128;

function attachmentKind(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico']).has(extension)) {
        return 'image';
    }
    if (new Set(['.wav', '.mp3', '.aiff', '.aif', '.aac', '.ogg', '.flac']).has(extension)) return 'audio';
    if (new Set(['.mp4', '.webm', '.mov', '.avi']).has(extension)) return 'video';
    return 'file';
}

class AttachmentRegistry {
    constructor(options = {}) {
        this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(1, options.ttlMs) : DEFAULT_TTL_MS;
        this.maxEntries = Number.isInteger(options.maxEntries)
            ? Math.max(1, options.maxEntries) : DEFAULT_MAX_ENTRIES;
        this.clock = options.clock || Date.now;
        this.entries = new Map();
    }

    register(sessionId, filePath, stat = fs.statSync(filePath)) {
        const owner = String(sessionId || '').trim();
        const resolved = path.resolve(String(filePath || ''));
        if (!owner) throw Object.assign(new Error('Attachment Session is required'), { code: 'INVALID_ATTACHMENT' });
        if (!stat?.isFile?.()) throw Object.assign(new Error('Attachment must be a file'), { code: 'INVALID_ATTACHMENT' });
        this.prune();
        while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
        const attachmentId = `attachment_${crypto.randomUUID()}`;
        const record = {
            attachmentId,
            sessionId: owner,
            path: resolved,
            displayName: path.basename(resolved),
            kind: attachmentKind(resolved),
            byteLen: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            expiresAt: this.clock() + this.ttlMs,
        };
        this.entries.set(attachmentId, record);
        return this.publicDescriptor(record);
    }

    publicDescriptor(record) {
        return {
            attachmentId: record.attachmentId,
            displayName: record.displayName,
            kind: record.kind,
            byteLen: record.byteLen,
        };
    }

    resolve(sessionId, descriptor = {}) {
        this.prune();
        const attachmentId = String(descriptor.attachmentId || '').trim();
        const record = this.entries.get(attachmentId);
        if (!record) throw Object.assign(new Error('Attachment capability is missing or expired'), { code: 'ATTACHMENT_EXPIRED' });
        if (record.sessionId !== String(sessionId || '').trim()) {
            throw Object.assign(new Error('Attachment belongs to another Session'), { code: 'ATTACHMENT_SESSION_MISMATCH' });
        }
        let stat;
        try { stat = fs.statSync(record.path); } catch {
            throw Object.assign(new Error('Attachment file is no longer available'), { code: 'ATTACHMENT_UNAVAILABLE' });
        }
        if (!stat.isFile() || Number(stat.size) !== record.byteLen || Number(stat.mtimeMs) !== record.mtimeMs) {
            throw Object.assign(new Error('Attachment changed after it was selected'), { code: 'ATTACHMENT_CHANGED' });
        }
        return { ...record };
    }

    resolveMany(sessionId, descriptors = []) {
        return (Array.isArray(descriptors) ? descriptors : []).map((descriptor) => this.resolve(sessionId, descriptor));
    }

    clearSession(sessionId) {
        const owner = String(sessionId || '').trim();
        for (const [attachmentId, record] of this.entries) {
            if (record.sessionId === owner) this.entries.delete(attachmentId);
        }
    }

    clear() { this.entries.clear(); }

    prune(now = this.clock()) {
        for (const [attachmentId, record] of this.entries) {
            if (record.expiresAt <= now) this.entries.delete(attachmentId);
        }
    }
}

module.exports = { AttachmentRegistry, attachmentKind };
