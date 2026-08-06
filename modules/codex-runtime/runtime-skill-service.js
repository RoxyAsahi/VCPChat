'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');
const { isSkillEnabled, normalizeSkillPolicy } = require('./skill-policy');

const MAX_SKILL_PREVIEW_BYTES = 96 * 1024;
const MAX_SKILL_DESCRIPTION = 2_000;
const SKILL_MARKER = /(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9._-]*)/g;

function stableSkillId(skillPath) {
    const normalized = path.normalize(String(skillPath || '')).toLowerCase();
    return `skill_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

function boundedText(value, maxLength) {
    return String(value || '').replace(/\0/g, '').trim().slice(0, maxLength);
}

function publicSkill(skill) {
    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        shortDescription: skill.shortDescription,
        displayName: skill.displayName,
        scope: skill.scope,
        sourceLabel: skill.sourceLabel,
        enabledByCodex: skill.enabledByCodex,
        dependencies: skill.dependencies,
    };
}

class RuntimeSkillService {
    constructor(context) {
        this.context = Object.freeze(context);
        this.catalogs = new Map();
    }

    _authority({ sessionId, profileId } = {}) {
        const repository = this.context.repository();
        const requestedSessionId = String(sessionId || '').trim();
        if (requestedSessionId) {
            const session = repository?.getSession(requestedSessionId);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            return {
                key: `session:${session.sessionId}`,
                cwd: path.resolve(session.workspaceRoot || this.context.projectRoot()),
                policy: normalizeSkillPolicy(session.configSnapshot?.skillPolicy),
            };
        }
        const requestedProfileId = String(profileId || '').trim();
        const profile = requestedProfileId ? this.context.resolveAgentProfile(requestedProfileId) : null;
        if (!profile) throw new CodexAppServerError('NOT_FOUND', 'Build Agent Profile was not found');
        return {
            key: `profile:${profile.id}`,
            cwd: path.resolve(profile.workspaceRoot || this.context.projectRoot()),
            policy: normalizeSkillPolicy(profile.skillPolicy),
        };
    }

    _normalizeEntry(authority, entry) {
        const skills = [];
        for (const metadata of Array.isArray(entry?.skills) ? entry.skills : []) {
            const rawPath = String(metadata?.path || '').trim();
            if (!rawPath || !metadata?.name) continue;
            const skillPath = path.resolve(rawPath);
            const id = stableSkillId(skillPath);
            skills.push({
                id,
                path: skillPath,
                name: boundedText(metadata.name, 160),
                description: boundedText(metadata.description, MAX_SKILL_DESCRIPTION),
                shortDescription: boundedText(
                    metadata.interface?.shortDescription || metadata.shortDescription, 320,
                ),
                displayName: boundedText(metadata.interface?.displayName || metadata.name, 160),
                scope: ['user', 'repo', 'system', 'admin'].includes(metadata.scope) ? metadata.scope : 'repo',
                sourceLabel: metadata.scope === 'repo' ? '工作目录' : metadata.scope === 'user' ? '用户技能' : 'Codex',
                enabledByCodex: metadata.enabled !== false,
                dependencies: metadata.dependencies && typeof metadata.dependencies === 'object'
                    ? metadata.dependencies : null,
            });
        }
        const byId = new Map(skills.map((skill) => [skill.id, skill]));
        this.catalogs.set(authority.key, { cwd: authority.cwd, byId, loadedAt: Date.now() });
        return {
            cwdLabel: path.basename(authority.cwd) || authority.cwd,
            skills: skills.map((skill) => ({
                ...publicSkill(skill),
                enabled: skill.enabledByCodex && isSkillEnabled(authority.policy, skill.id),
            })),
            errors: (Array.isArray(entry?.errors) ? entry.errors : []).slice(0, 20).map((error) => ({
                message: boundedText(error?.message || error?.error || error, 1_000),
            })),
        };
    }

    async list(options = {}) {
        await this.context.start();
        const authority = this._authority(options);
        const result = await this.context.transport().request('skills/list', {
            cwds: [authority.cwd],
            forceReload: options.forceReload === true,
        });
        const entries = Array.isArray(result?.data) ? result.data : [];
        const entry = entries.find((item) => path.resolve(String(item?.cwd || '')) === authority.cwd)
            || entries[0] || { cwd: authority.cwd, skills: [], errors: [] };
        return this._normalizeEntry(authority, entry);
    }

    async detail({ skillId, ...options } = {}) {
        const authority = this._authority(options);
        let catalog = this.catalogs.get(authority.key);
        if (!catalog || catalog.cwd !== authority.cwd || !catalog.byId.has(String(skillId || ''))) {
            await this.list(options);
            catalog = this.catalogs.get(authority.key);
        }
        const skill = catalog?.byId.get(String(skillId || ''));
        if (!skill) throw new CodexAppServerError('SKILL_NOT_FOUND', 'Codex Skill was not found');
        let content = '';
        let truncated = false;
        try {
            const stat = await fs.promises.stat(skill.path);
            if (!stat.isFile()) throw new Error('Skill entry is not a file');
            const handle = await fs.promises.open(skill.path, 'r');
            try {
                const size = Math.min(stat.size, MAX_SKILL_PREVIEW_BYTES);
                const buffer = Buffer.alloc(size);
                const { bytesRead } = await handle.read(buffer, 0, size, 0);
                content = buffer.subarray(0, bytesRead).toString('utf8');
                truncated = stat.size > MAX_SKILL_PREVIEW_BYTES;
            } finally {
                await handle.close();
            }
        } catch (error) {
            throw new CodexAppServerError('SKILL_READ_FAILED', error?.message || 'Could not read SKILL.md');
        }
        return { ...publicSkill(skill), content, truncated };
    }

    invalidate() {
        this.catalogs.clear();
    }

    async resolveTurnInputs(session, prompt) {
        const names = new Set();
        SKILL_MARKER.lastIndex = 0;
        for (const match of String(prompt || '').matchAll(SKILL_MARKER)) names.add(match[1].toLowerCase());
        if (!names.size) return [];
        const options = { sessionId: session.sessionId };
        const authority = this._authority(options);
        let catalog = this.catalogs.get(authority.key);
        if (!catalog || catalog.cwd !== authority.cwd) {
            await this.list(options);
            catalog = this.catalogs.get(authority.key);
        }
        const matches = [];
        for (const name of names) {
            const candidates = [...(catalog?.byId.values() || [])]
                .filter((skill) => skill.name.toLowerCase() === name || skill.displayName.toLowerCase() === name);
            if (candidates.length > 1) {
                throw new CodexAppServerError('SKILL_AMBIGUOUS', `Skill marker $${name} matches multiple Skills`);
            }
            const skill = candidates[0];
            if (!skill) throw new CodexAppServerError('SKILL_NOT_FOUND', `Skill $${name} is not available in this workspace`);
            if (!skill.enabledByCodex || !isSkillEnabled(authority.policy, skill.id)) {
                throw new CodexAppServerError('SKILL_DISABLED', `Skill $${name} is disabled for this Session`);
            }
            matches.push({ type: 'skill', name: skill.name, path: skill.path });
        }
        return matches;
    }
}

module.exports = { RuntimeSkillService, stableSkillId };
