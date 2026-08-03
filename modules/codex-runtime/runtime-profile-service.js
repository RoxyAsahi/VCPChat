'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { CodexAppServerError } = require('./appServerTransport');
const { normalizeProfile, PROFILE_SCHEMA_VERSION } = require('./dataContracts');
const {
    compatibilitySession,
    explicitAgent,
    normalizeApprovalPolicy,
    normalizeInstructionMode,
    normalizePersonality,
    normalizePermissionMode,
    normalizeReasoningEffort,
    normalizeSandboxMode,
    reasoningEffortsFromModel,
    safeAvatarFile,
    sameIdentity,
} = require('./runtime-normalizers');

class RuntimeProfileService {
    constructor(context) {
        this.context = context;
    }

    listAgentProfiles() {
        const repository = this._repository();
        this.ensureDefaultAgentProfile();
        const profiles = this.agentCatalog().map((entry) => ({
            id: entry.catalogId,
            name: entry.name,
            revision: Number(entry.profile?.revision || 1),
            profileRevision: Number(entry.profile?.profileRevision || entry.profile?.revision || 1),
            schemaVersion: PROFILE_SCHEMA_VERSION,
            model: entry.profile?.model || '',
            instructionMode: normalizeInstructionMode(
                entry.profile?.instructionMode,
                entry.profile?.baseInstructions || entry.profile?.systemPrompt,
            ),
            baseInstructions: entry.profile?.baseInstructions || entry.profile?.systemPrompt || '',
            systemPrompt: entry.profile?.baseInstructions || entry.profile?.systemPrompt || '',
            developerInstructions: entry.profile?.developerInstructions || '',
            personality: normalizePersonality(entry.profile?.personality),
            workspaceRoot: entry.profile?.workspaceRoot || '',
            permissionMode: normalizePermissionMode(entry.profile?.permissionMode),
            reasoningEffort: normalizeReasoningEffort(entry.profile?.reasoningEffort),
            reasoningEfforts: Array.isArray(entry.profile?.reasoningEfforts) ? entry.profile.reasoningEfforts : [],
            executionProfile: 'toolbox-only',
            avatarUrl: this.agentAvatarUrl(entry.catalogId, entry.profile),
        }));
        for (const session of repository.listSessions({ archived: false })) {
            const idValue = session.agentCatalogId || session.agentId;
            if (!idValue || profiles.some((profile) => sameIdentity(profile.id, idValue))) continue;
            profiles.push({
                id: idValue,
                name: session.agentNameSnapshot || session.configSnapshot?.agentName || idValue,
                revision: Number(session.configSnapshot?.profileRevision || 1),
                model: session.configSnapshot?.model || '',
                instructionMode: normalizeInstructionMode(
                    session.configSnapshot?.instructionMode,
                    session.configSnapshot?.baseInstructions,
                ),
                baseInstructions: session.configSnapshot?.baseInstructions || '',
                systemPrompt: session.configSnapshot?.baseInstructions || '',
                developerInstructions: session.configSnapshot?.developerInstructions || '',
                personality: normalizePersonality(session.configSnapshot?.personality),
                workspaceRoot: session.workspaceRoot || '',
                permissionMode: normalizePermissionMode(session.configSnapshot?.permissionMode),
                reasoningEffort: normalizeReasoningEffort(session.configSnapshot?.reasoningEffort),
                reasoningEfforts: Array.isArray(session.configSnapshot?.reasoningEfforts)
                    ? session.configSnapshot.reasoningEfforts : [],
                executionProfile: 'toolbox-only',
                avatarUrl: session.configSnapshot?.agentAvatar || '',
            });
        }
        return profiles;
    }

    saveAgentProfile(input = {}) {
        this._repository();
        this.context.assertProjectionWritable();
        const incomingPatch = input.patch && typeof input.patch === 'object' ? input.patch : input;
        const requestedId = String(input.profileId || input.agentId || '').trim();
        const requestedDisplayName = String(incomingPatch.name || '').trim();
        const directIdentity = requestedId
            ? this.resolveCanonicalAgent(requestedId, { failOnAmbiguous: true }) : null;
        const namedIdentity = requestedDisplayName
            ? this.resolveCanonicalAgent(requestedDisplayName, { failOnAmbiguous: true }) : null;
        const existing = directIdentity?.profile ? directIdentity : namedIdentity?.profile ? namedIdentity : null;
        const patch = existing ? { ...existing.profile, ...incomingPatch } : incomingPatch;
        const {
            name, systemPrompt, instructionMode, baseInstructions, developerInstructions,
            personality, model, reasoningEffort, workspaceRoot, permissionMode,
        } = patch;
        const displayName = String(name || '').trim();
        const prompt = String(
            Object.prototype.hasOwnProperty.call(incomingPatch, 'baseInstructions')
                ? incomingPatch.baseInstructions
                : Object.prototype.hasOwnProperty.call(incomingPatch, 'systemPrompt')
                    ? incomingPatch.systemPrompt
                    : baseInstructions ?? systemPrompt ?? '',
        ).trim();
        const normalizedInstructionMode = normalizeInstructionMode(instructionMode, prompt);
        const normalizedDeveloperInstructions = String(developerInstructions || '').trim();
        const normalizedPersonality = normalizePersonality(personality);
        const idValue = requestedId || displayName
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!displayName || !idValue || idValue === '.' || idValue === '..' || /[\\/:*?"<>|]/.test(idValue)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Build Agent name is invalid');
        }
        if (normalizedInstructionMode === 'vchat-identity' && !prompt) {
            throw new CodexAppServerError('INVALID_INPUT', 'VChat identity mode requires baseInstructions');
        }
        if (existing && (!requestedId || !sameIdentity(existing.catalogId, requestedId))) {
            throw new CodexAppServerError('ALREADY_EXISTS', `Build Agent ${displayName} already exists`);
        }
        if (existing) {
            const expected = Number(input.expectedProfileRevision);
            const actual = Number(existing.profile?.profileRevision || existing.profile?.revision || 1);
            if (!Number.isInteger(expected) || expected !== actual) {
                throw new CodexAppServerError('PROFILE_CONFIG_CONFLICT', 'Agent Profile changed in another view', {
                    current: { id: existing.catalogId, ...normalizeProfile(existing.profile, existing.catalogId) },
                });
            }
        }
        const directory = path.join(this.context.agentsDir(), idValue);
        fs.mkdirSync(directory, { recursive: true });
        let normalizedWorkspace = '';
        if (String(workspaceRoot || '').trim()) {
            normalizedWorkspace = path.resolve(String(workspaceRoot).trim());
            let stat = null;
            try { stat = fs.statSync(normalizedWorkspace); } catch { /* validated below */ }
            if (!stat?.isDirectory()) {
                throw new CodexAppServerError('INVALID_WORKSPACE', 'Workspace directory does not exist');
            }
        }
        const previousRevision = Number(existing?.profile?.profileRevision || existing?.profile?.revision || 0);
        const avatarFile = safeAvatarFile(existing?.profile?.avatarFile);
        const normalizedModel = String(model || '').trim();
        const reasoning = this.validateReasoningEffort(normalizedModel, reasoningEffort);
        const profile = normalizeProfile({
            name: displayName,
            instructionMode: normalizedInstructionMode,
            baseInstructions: prompt,
            systemPrompt: prompt,
            developerInstructions: normalizedDeveloperInstructions,
            personality: normalizedPersonality,
            revision: previousRevision + 1,
            profileRevision: previousRevision + 1,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            profileId: idValue,
            executionProfile: 'toolbox-only',
            permissionMode: normalizePermissionMode(permissionMode),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(reasoning.effort ? { reasoningEffort: reasoning.effort } : {}),
            ...(reasoning.supported.length ? { reasoningEfforts: reasoning.supported } : {}),
            ...(normalizedWorkspace ? { workspaceRoot: normalizedWorkspace } : {}),
            ...(avatarFile ? { avatarFile } : {}),
            updatedAt: Date.now(),
        }, idValue);
        const configPath = path.join(directory, 'config.json');
        const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, configPath);
        return { success: true, profile: { id: idValue, ...profile, avatarUrl: this.agentAvatarUrl(idValue) } };
    }

    saveAgentAvatar({ agentId, profileId, expectedProfileRevision, avatarData } = {}) {
        this._repository();
        this.context.assertProjectionWritable();
        const idValue = String(profileId || agentId || '').trim();
        if (!idValue || /[\\/:*?"<>|]/.test(idValue)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Invalid Build Agent identity');
        }
        const type = String(avatarData?.type || '').toLowerCase();
        const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
        const ext = extensions[type];
        const bytes = Buffer.from(avatarData?.buffer || []);
        if (!ext || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
            throw new CodexAppServerError('INVALID_INPUT', 'Invalid Build Agent avatar');
        }
        this.ensureDefaultAgentProfile();
        const resolved = this.resolveAgentProfile(idValue);
        if (!resolved || !sameIdentity(resolved.id, idValue)) {
            throw new CodexAppServerError('NOT_FOUND', 'Build Agent Profile was not found');
        }
        const actualRevision = Number(resolved.profileRevision || resolved.revision || 1);
        if (!Number.isInteger(Number(expectedProfileRevision)) || Number(expectedProfileRevision) !== actualRevision) {
            throw new CodexAppServerError('PROFILE_CONFIG_CONFLICT', 'Agent Profile changed in another view', {
                current: normalizeProfile(resolved, resolved.id),
            });
        }
        const revision = actualRevision + 1;
        const avatarFile = `avatar-r${revision}${ext}`;
        const directory = path.join(this.context.agentsDir(), resolved.id);
        const avatarPath = path.join(directory, avatarFile);
        const avatarTemporaryPath = `${avatarPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(avatarTemporaryPath, bytes);
        fs.renameSync(avatarTemporaryPath, avatarPath);
        const configPath = path.join(directory, 'config.json');
        const configTemporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        const { id: _id, avatarUrl: _avatarUrl, ...stored } = resolved;
        const profile = normalizeProfile({
            ...stored,
            revision,
            profileRevision: revision,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            profileId: resolved.id,
            avatarFile,
            updatedAt: Date.now(),
        }, resolved.id);
        fs.writeFileSync(configTemporaryPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
        fs.renameSync(configTemporaryPath, configPath);
        const avatarUrl = pathToFileURL(avatarPath).toString();
        return { success: true, revision, avatarUrl, profile: { id: resolved.id, ...profile, avatarUrl } };
    }

    async applyAgentProfileToSession({
        sessionId, expectedConfigRevision, previewOnly = false, createNewSession = false,
    } = {}) {
        const repository = this._repository();
        this.context.assertProjectionWritable();
        const session = repository.getSession(String(sessionId || ''));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const profile = this.resolveAgentProfile(session.agentCatalogId || session.agentId);
        if (!profile) throw new CodexAppServerError('NOT_FOUND', 'Build Agent Profile was not found');
        const differences = [];
        const addDifference = (field, current, next, identity = false) => {
            if (String(current ?? '') !== String(next ?? '')) {
                differences.push({ field, current: current ?? null, next: next ?? null, identity });
            }
        };
        const profileMode = normalizeInstructionMode(
            profile.instructionMode,
            profile.baseInstructions || profile.systemPrompt,
        );
        addDifference('instructionMode', normalizeInstructionMode(
            session.configSnapshot?.instructionMode,
            session.configSnapshot?.baseInstructions,
        ), profileMode, true);
        addDifference('baseInstructions', session.configSnapshot?.baseInstructions || '',
            profile.baseInstructions || profile.systemPrompt || '', profileMode === 'vchat-identity');
        addDifference('developerInstructions', session.configSnapshot?.developerInstructions || '',
            profile.developerInstructions || '', profileMode === 'codex-managed');
        addDifference('personality', normalizePersonality(session.configSnapshot?.personality),
            normalizePersonality(profile.personality), profileMode === 'codex-managed');
        const profileWorkspace = profile.workspaceRoot ? path.resolve(profile.workspaceRoot) : session.workspaceRoot;
        addDifference('workspaceRoot', session.workspaceRoot || '', profileWorkspace || '', true);
        addDifference('name', session.agentNameSnapshot || session.configSnapshot?.agentName || '', profile.name || '');
        addDifference('avatar', session.configSnapshot?.agentAvatar || '', profile.avatarUrl || '');
        addDifference('model', session.configSnapshot?.model || '', profile.model || session.configSnapshot?.model || '');
        addDifference('reasoningEffort', session.configSnapshot?.reasoningEffort || '', profile.reasoningEffort || '');
        addDifference('permissionMode', normalizePermissionMode(session.configSnapshot?.permissionMode),
            normalizePermissionMode(profile.permissionMode));
        addDifference('profileRevision', Number(session.configSnapshot?.profileRevision || 1),
            Number(profile.revision || 1));
        const identityChanges = differences.filter((entry) => entry.identity).map((entry) => entry.field);
        if (previewOnly) {
            return {
                applied: false,
                requiresNewSession: Boolean(session.threadId && identityChanges.length),
                identityChanges,
                differences,
                profile: { id: profile.id, revision: Number(profile.revision || 1) },
            };
        }
        if (session.threadId && identityChanges.length) {
            if (!createNewSession) {
                return {
                    applied: false,
                    requiresNewSession: true,
                    identityChanges,
                    differences,
                    profile: { id: profile.id, revision: Number(profile.revision || 1) },
                };
            }
            const created = await this.context.createSession({
                agentId: profile.id,
                title: `${session.title || profile.name || 'Agent'}（Profile 更新）`,
                workspaceRoot: profileWorkspace,
                model: profile.model || session.configSnapshot?.model,
                permissionMode: profile.permissionMode,
                instructionMode: profileMode,
                baseInstructions: profile.baseInstructions || profile.systemPrompt || '',
                developerInstructions: profile.developerInstructions || '',
                personality: profile.personality,
                reasoningEffort: profile.reasoningEffort,
            });
            return { applied: false, createdNewSession: true, requiresNewSession: true, differences, session: created };
        }
        const permissionMode = normalizePermissionMode(profile.permissionMode);
        const updated = repository.updateSessionConfig(session.sessionId, Number(expectedConfigRevision), {
            workspaceRoot: profileWorkspace,
            agentNameSnapshot: profile.name || session.agentNameSnapshot,
            configSnapshot: {
                ...(session.configSnapshot || {}),
                profileId: profile.id,
                profileRevision: Number(profile.revision || 1),
                instructionMode: profileMode,
                baseInstructions: profile.baseInstructions || profile.systemPrompt || '',
                developerInstructions: String(profile.developerInstructions || ''),
                personality: normalizePersonality(profile.personality),
                agentName: profile.name || session.agentNameSnapshot || '',
                agentAvatar: profile.avatarUrl || session.configSnapshot?.agentAvatar || '',
                model: profile.model || session.configSnapshot?.model,
                reasoningEffort: normalizeReasoningEffort(profile.reasoningEffort),
                reasoningEfforts: Array.isArray(profile.reasoningEfforts) ? profile.reasoningEfforts : [],
                permissionMode,
                approvalPolicy: normalizeApprovalPolicy(permissionMode),
                provider: 'vcp_toolbox',
                executionProfile: 'toolbox-only',
            },
        });
        if (!updated.updated) {
            throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
                current: updated.session,
            });
        }
        return { applied: true, requiresNewSession: false, differences, session: compatibilitySession(updated.session) };
    }

    configSnapshot(options = {}) {
        const settings = this.context.getSettings() || {};
        const toolboxConfigured = Boolean(settings.vcpServerUrl && settings.vcpApiKey);
        const agentId = explicitAgent(options.agentId || options.agent) || 'codex';
        const profile = this.resolveAgentProfile(agentId);
        const provider = options.provider || (profile ? 'vcp_toolbox' : (toolboxConfigured ? 'vcp_toolbox' : 'codex'));
        const permissionMode = normalizePermissionMode(
            options.permissionMode || options.approvalPolicy || profile?.permissionMode,
        );
        const model = options.model || profile?.model || settings.agentRuntime?.codex?.model
            || settings.agentRuntime?.tui?.defaultModel || (toolboxConfigured ? 'Nova' : 'gpt-5.1-codex');
        const baseInstructions = options.baseInstructions ?? options.systemPrompt
            ?? profile?.baseInstructions ?? profile?.systemPrompt ?? '';
        const requestedInstructionMode = options.instructionMode ?? profile?.instructionMode;
        const instructionMode = requestedInstructionMode
            ? normalizeInstructionMode(requestedInstructionMode, baseInstructions)
            : (!String(baseInstructions || '').trim() && sameIdentity(agentId, 'codex')
                ? 'codex-managed' : 'vchat-identity');
        const reasoning = this.validateReasoningEffort(
            model,
            options.reasoningEffort ?? profile?.reasoningEffort,
            { supported: options.reasoningEfforts || profile?.reasoningEfforts },
        );
        return {
            model,
            instructionMode,
            personality: normalizePersonality(options.personality ?? profile?.personality),
            permissionMode,
            approvalPolicy: normalizeApprovalPolicy(permissionMode),
            sandbox: normalizeSandboxMode(options.sandbox),
            baseInstructions: String(baseInstructions || '').trim(),
            developerInstructions: String(options.developerInstructions ?? profile?.developerInstructions ?? '').trim(),
            reasoningEffort: reasoning.effort,
            reasoningEfforts: reasoning.supported,
            agentName: options.agentName || options.name || profile?.name || '',
            agentAvatar: options.agentAvatar || options.avatar || profile?.avatarUrl
                || this.agentAvatarUrl(profile?.id || agentId),
            profileId: profile?.id || agentId,
            profileRevision: Number(profile?.revision || 1),
            provider,
            executionProfile: options.executionProfile
                || (profile || provider === 'vcp_toolbox' ? 'toolbox-only' : 'codex-native'),
        };
    }

    resolveAgentProfile(agentId) {
        this.ensureDefaultAgentProfile();
        const wanted = String(agentId || '').trim();
        const agentsDir = this.context.agentsDir();
        if (!wanted || !agentsDir || !fs.existsSync(agentsDir)) return null;
        const readConfig = (directory) => {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
                return value && typeof value === 'object'
                    ? normalizeProfile(value, path.basename(directory)) : null;
            } catch {
                return null;
            }
        };
        if (!/[\\/:*?"<>|]/.test(wanted)) {
            const direct = readConfig(path.join(agentsDir, wanted));
            if (direct) return { ...direct, id: wanted, avatarUrl: this.agentAvatarUrl(wanted, direct) };
        }
        try {
            for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const profile = readConfig(path.join(agentsDir, entry.name));
                if (profile && (sameIdentity(entry.name, wanted) || sameIdentity(profile.name, wanted))) {
                    return { ...profile, id: entry.name, avatarUrl: this.agentAvatarUrl(entry.name, profile) };
                }
            }
        } catch {
            return null;
        }
        return null;
    }

    agentCatalog() {
        this.ensureDefaultAgentProfile();
        const agentsDir = this.context.agentsDir();
        if (!agentsDir || !fs.existsSync(agentsDir)) return [];
        const result = [];
        try {
            for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                try {
                    const config = normalizeProfile(
                        JSON.parse(fs.readFileSync(path.join(agentsDir, entry.name, 'config.json'), 'utf8')),
                        entry.name,
                    );
                    result.push({ catalogId: entry.name, name: String(config?.name || entry.name), profile: config || {} });
                } catch {
                    // Invalid Agent folders are not identities.
                }
            }
        } catch {
            return [];
        }
        return result;
    }

    ensureDefaultAgentProfile() {
        const agentsDir = this.context.agentsDir();
        const directory = path.join(agentsDir, 'Nova');
        const configPath = path.join(directory, 'config.json');
        if (fs.existsSync(configPath)) return;
        if (fs.existsSync(agentsDir)) {
            try {
                for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    try {
                        const config = JSON.parse(fs.readFileSync(path.join(agentsDir, entry.name, 'config.json'), 'utf8'));
                        if (sameIdentity(entry.name, 'Nova') || sameIdentity(config?.name, 'Nova')) return;
                    } catch {
                        // Invalid folders do not suppress the safe default.
                    }
                }
            } catch {
                // Directory creation below remains the fail-safe path.
            }
        }
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify({
            schemaVersion: PROFILE_SCHEMA_VERSION,
            profileId: 'Nova',
            profileRevision: 1,
            name: 'Nova',
            systemPrompt: '{{Nova}}',
            baseInstructions: '{{Nova}}',
            revision: 1,
            executionProfile: 'toolbox-only',
            permissionMode: 'ask',
        }, null, 2)}\n`, 'utf8');
    }

    agentAvatarUrl(agentId, profileConfig = null) {
        const directory = path.join(this.context.agentsDir(), String(agentId || ''));
        let configured = profileConfig;
        if (!configured) {
            try { configured = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')); } catch { configured = null; }
        }
        const avatarFile = safeAvatarFile(configured?.avatarFile);
        if (avatarFile) {
            const configuredPath = path.join(directory, avatarFile);
            if (fs.existsSync(configuredPath)) return pathToFileURL(configuredPath).toString();
        }
        for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
            const avatarPath = path.join(directory, `avatar${ext}`);
            if (fs.existsSync(avatarPath)) return pathToFileURL(avatarPath).toString();
        }
        return '';
    }

    resolveCanonicalAgent(value, { failOnAmbiguous = false } = {}) {
        const wanted = String(value || '').trim();
        if (!wanted) return null;
        const catalog = this.agentCatalog();
        const direct = catalog.find((entry) => sameIdentity(entry.catalogId, wanted));
        if (direct) return direct;
        const byName = catalog.filter((entry) => sameIdentity(entry.name, wanted));
        if (byName.length === 1) return byName[0];
        if (byName.length > 1 && failOnAmbiguous) {
            throw new CodexAppServerError(
                'AGENT_IDENTITY_AMBIGUOUS',
                `Agent name ${wanted} matches multiple catalog entries`,
            );
        }
        return byName.length === 1 ? byName[0] : { catalogId: wanted, name: wanted, profile: null };
    }

    repairSessionIdentity(session) {
        const repository = this.context.repository();
        if (!session || repository?.readOnly) return session;
        const current = String(session.agentCatalogId || '').trim();
        const identity = this.resolveCanonicalAgent(current || session.agentId, { failOnAmbiguous: false });
        if (!identity || (!identity.profile && current)) return session;
        const nextCatalogId = identity.catalogId || current || session.agentId;
        const nextName = session.agentNameSnapshot || identity.name || session.configSnapshot?.agentName || session.agentId;
        if (sameIdentity(current, nextCatalogId) && session.agentNameSnapshot === nextName
            && sameIdentity(session.agentId, nextCatalogId)) return session;
        return repository.saveSession({
            ...session,
            agentId: nextCatalogId,
            agentCatalogId: nextCatalogId,
            agentNameSnapshot: nextName,
            updatedAt: Date.now(),
        });
    }

    repairSessionConfig(session) {
        const repository = this.context.repository();
        if (!session || repository?.readOnly) return session;
        const original = session.configSnapshot || {};
        const config = { ...original };
        const profile = this.resolveAgentProfile(session.agentId);
        const baseInstructions = String(config.baseInstructions || '').trim();
        const developerInstructions = String(config.developerInstructions || '').trim();
        const placeholder = /^\{\{([^{}]+)\}\}$/.exec(developerInstructions);
        let identityRepaired = false;
        if (!baseInstructions && placeholder && (
            sameIdentity(placeholder[1], session.agentId) || sameIdentity(placeholder[1], profile?.name)
        )) {
            config.baseInstructions = developerInstructions;
            config.developerInstructions = '';
            identityRepaired = true;
        } else if (!baseInstructions && !developerInstructions && String(profile?.systemPrompt || '').trim()) {
            config.baseInstructions = String(profile.systemPrompt).trim();
            config.agentName = config.agentName || profile.name || '';
            identityRepaired = true;
        }
        if (!config.instructionMode) {
            config.instructionMode = String(config.baseInstructions || '').trim() ? 'vchat-identity' : 'codex-managed';
            config.personality = 'none';
            identityRepaired = true;
        }
        if (!config.executionProfile) config.executionProfile = 'toolbox-only';
        if (identityRepaired) config.identityMigrationVersion = 1;
        if (JSON.stringify(config) === JSON.stringify(original)) return session;
        return repository.saveSession({ ...session, configSnapshot: config, updatedAt: Date.now() });
    }

    reasoningEffortsForModel(modelId) {
        const wanted = String(modelId || '').trim();
        if (!wanted) return [];
        const models = this.context.getModels() || [];
        const model = (Array.isArray(models) ? models : []).find((entry) => {
            const idValue = typeof entry === 'string' ? entry : entry?.id || entry?.name;
            return String(idValue || '').trim() === wanted;
        });
        return reasoningEffortsFromModel(model);
    }

    validateReasoningEffort(modelId, value, { supported } = {}) {
        const effort = normalizeReasoningEffort(value);
        const advertised = Array.isArray(supported) && supported.length
            ? [...new Set(supported.map((item) => String(item || '').trim()).filter(Boolean))]
            : this.reasoningEffortsForModel(modelId);
        if (effort && !advertised.includes(effort)) {
            throw new CodexAppServerError(
                'REASONING_EFFORT_UNSUPPORTED',
                `Model ${modelId || '(default)'} does not advertise reasoning effort ${effort}`,
                { model: modelId || null, supported: advertised },
            );
        }
        return { effort, supported: advertised };
    }

    effectiveReasoningEffort(config = {}) {
        return this.validateReasoningEffort(config.model, config.reasoningEffort, {
            supported: config.reasoningEfforts,
        }).effort;
    }

    _repository() {
        this.context.ensureProjectionStore();
        const repository = this.context.repository();
        if (!repository) throw new CodexAppServerError('PROJECTION_UNAVAILABLE', 'Projection repository is unavailable');
        return repository;
    }
}

module.exports = { RuntimeProfileService };
