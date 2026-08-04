'use strict';

const fs = require('fs');
const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');
const {
    hasToolboxConfiguration,
    normalizeInstructionMode,
    normalizePersonality,
    notificationItemId,
    serializeError,
    toolboxConfigFingerprint,
} = require('./runtime-normalizers');
const { normalizeTimelineBlock } = require('./projection/v2');

function applySettingsNotification(context, repository, session, message) {
    if (message.method !== 'thread/settings/updated' || !session) return;
    const target = context.configApplyTargets().get(session.threadId);
    if (!target || target.runtimeGeneration !== context.runtimeGeneration()) return;
    const settings = message.params?.threadSettings || message.params?.thread_settings;
    if (!settings || String(message.params?.threadId || '').trim() !== session.threadId) return;
    const expected = target.settings || {};
    const actual = {
        cwd: settings.cwd,
        model: settings.model,
        approvalPolicy: settings.approvalPolicy,
        effort: settings.effort ?? null,
        personality: settings.personality ?? null,
    };
    const matches = actual.cwd === expected.cwd
        && actual.model === expected.model
        && actual.approvalPolicy === expected.approvalPolicy
        && actual.effort === (expected.effort ?? null)
        && actual.personality === (expected.personality ?? null);
    if (!matches) return;
    const applied = repository.markSessionConfigApplied(target.sessionId, target.revision, target.snapshot);
    clearTimeout(target.timeout);
    context.configApplyTargets().delete(session.threadId);
    if (applied?.appliedRuntimeConfigRevision === target.revision) {
        context.sendSessionConfigEvent('session.config.applied', applied);
        target.resolve?.(applied);
    }
}

function notificationEvent(context, message, projected, session, threadId, itemId, projectionPatch) {
    if (!session) return { runtime: 'codex', ...message };
    return {
        runtime: 'codex', type: 'projection.updated', method: message.method,
        sessionId: session.sessionId, threadId,
        turnId: message?.params?.turnId || message?.params?.turn?.id || null,
        turnStatus: message?.params?.turn?.status || null,
        itemId, projectionPatch,
        activity: context.threadStates().get(threadId)?.activity || 'idle',
    };
}

class RuntimeHostService {
    constructor(context) {
        this.context = Object.freeze(context);
        this.transportWired = false;
        this.toolboxConfigFingerprint = null;
        this.toolboxReconfiguration = null;
        this.toolboxRequestedSettings = null;
        this.toolboxRequestedFingerprint = null;
        this.toolboxRequestedGeneration = 0;
        this.toolboxAppliedGeneration = 0;
    }

    async start() {
        this.context.assertProjectionWritable();
        if (this.context.state() === 'ready') return this.context.getStatus();
        const currentStart = this.context.startPromise();
        if (currentStart) return currentStart;
        if (Date.now() < this.context.runtimeRetryAfter()) {
            throw new CodexAppServerError('RUNTIME_RETRY_BACKOFF', 'Codex App Server restart is temporarily rate limited', {
                retryAfterMs: this.context.runtimeRetryAfter() - Date.now(),
            });
        }
        const startPromise = (async () => {
            const startedAt = this.context.diagnosticClock();
            this.context.setIntentionalStop(false);
            this.context.setLastError(null);
            this.context.ensureProjectionStore();
            const settings = this.context.getSettings() || {};
            await this.ensureResponsesAdapter(settings);
            this.context.beginGeneration();
            const transport = this.context.transport() || this.context.transportFactory()({
                cwd: this.context.projectRoot(),
                clientVersion: 'vcp-chat-codex-agent-0.1.0',
                executable: settings.agentRuntime?.codex?.executable || settings.codexAppServerPath,
                supportedVersionLine: '0.146',
                env: this.context.responsesAdapter()
                    ? { VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY: this.context.responsesAdapter().capability }
                    : {},
                unsetEnv: this.context.responsesAdapter() ? ['VCP_TOOLBOX_API_KEY', 'VCP_TOOLBOX_URL'] : [],
            });
            this.context.setTransport(transport);
            this.wireTransport();
            try {
                const operation = this.context.createOperationContext();
                await transport.start();
                this.context.assertOperationContext(operation);
                await this.ensureBridge(settings);
                this.context.assertOperationContext(operation);
                this.context.normalizeUnboundThreadOperations();
                await this.context.recoverKnownThreadOperations();
                this.context.assertOperationContext(operation);
                this.toolboxConfigFingerprint = toolboxConfigFingerprint(settings);
                this.context.setState('ready');
                this.context.setRuntimeStartFailures(0);
                this.context.setRuntimeRetryAfter(0);
                this.context.diagnostic('runtime-process-ready', {
                    durationMs: this.context.diagnosticClock() - startedAt,
                });
            } catch (error) {
                this.context.closeGeneration('Codex App Server failed to start');
                this.context.setState('error');
                this.context.setLastError(serializeError(error));
                this.context.setIntentionalStop(true);
                await transport.stop().catch(() => null);
                await this.context.responsesAdapter()?.stop().catch(() => null);
                this.context.setResponsesAdapter(null);
                const failures = this.context.runtimeStartFailures() + 1;
                this.context.setRuntimeStartFailures(failures);
                this.context.setRuntimeRetryAfter(Date.now() + Math.min(30_000, 500 * (2 ** Math.min(6, failures - 1))));
                throw error;
            }
            return this.context.getStatus();
        })().finally(() => this.context.setStartPromise(null));
        this.context.setStartPromise(startPromise);
        return startPromise;
    }

    async stop() {
        this.context.setState('stopping');
        this.context.setIntentionalStop(true);
        this.context.invalidateGeneration('VChat Agent Runtime stopped');
        await this.context.failClosedNativeApprovals('VChat Agent Runtime stopped');
        await this.context.failClosedToolboxApprovals('VChat Agent Runtime stopped');
        this.context.clearInteractions('codex-native');
        this.context.clearInteractions('toolbox');
        this.context.clearScheduledConfigApplies();
        const error = new CodexAppServerError('RUNTIME_STOPPED', 'VChat Agent Runtime stopped during compaction');
        this.rejectCompactionWaiters(error);
        await this.context.interruptDynamicCalls('VChat Agent Runtime stopped');
        this.context.clearInteractionTimers();
        await this.context.transport()?.stop();
        await this.context.bridge()?.stop();
        await this.context.responsesAdapter()?.stop();
        this.context.repository()?.close();
        this.context.clearHostResources();
        this.reset();
        this.context.setState('stopped');
        return this.context.getStatus();
    }

    providerParams() {
        const settings = this.context.getSettings() || {};
        const adapter = this.context.responsesAdapter();
        if (!settings.vcpServerUrl || !settings.vcpApiKey || !adapter?.baseUrl) return {};
        return {
            modelProvider: 'vcp_toolbox',
            config: {
                'model_providers.vcp_toolbox.name': 'VCPToolBox compatibility adapter',
                'model_providers.vcp_toolbox.base_url': adapter.baseUrl,
                'model_providers.vcp_toolbox.env_key': 'VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY',
                'model_providers.vcp_toolbox.wire_api': 'responses',
                'model_providers.vcp_toolbox.requires_openai_auth': false,
            },
        };
    }

    async ensureResponsesAdapter(settings = this.context.getSettings() || {}) {
        const current = this.context.responsesAdapter();
        if (current) return current.start();
        if (!settings.vcpServerUrl || !settings.vcpApiKey) return null;
        const adapter = this.context.responsesAdapterFactory()({
            toolboxUrl: settings.vcpServerUrl,
            toolboxApiKey: settings.vcpApiKey,
            onRequest: (identity) => this.context.diagnostic('toolbox-response-request', identity),
            resolveInstructions: ({ threadId, sessionId: providerSessionId }) => {
                const session = threadId ? this.context.repository()?.getSessionByThread(threadId) : null;
                if (!session) {
                    throw new CodexAppServerError('SESSION_NOT_FOUND',
                        'ToolBox request is not bound to a known VChat Agent Session');
                }
                if (session.configSnapshot?.executionProfile !== 'toolbox-only') {
                    throw new CodexAppServerError('PROFILE_MISMATCH',
                        'Only toolbox-only Threads may use the VCPToolBox Responses adapter');
                }
                if (providerSessionId && providerSessionId !== session.threadId) {
                    throw new CodexAppServerError('SESSION_IDENTITY_MISMATCH',
                        'ToolBox provider session identity does not match its Codex Thread');
                }
                const appliedConfig = session.appliedRuntimeConfigRevision > 0
                    ? session.appliedRuntimeConfig : session.configSnapshot;
                const mode = normalizeInstructionMode(
                    appliedConfig?.instructionMode,
                    appliedConfig?.baseInstructions,
                );
                return mode === 'codex-managed'
                    ? {
                        mode,
                        developerInstructions: String(appliedConfig?.developerInstructions || ''),
                        personality: normalizePersonality(appliedConfig?.personality),
                    }
                    : { mode, baseInstructions: String(appliedConfig?.baseInstructions || '') };
            },
        });
        this.context.setResponsesAdapter(adapter);
        try {
            await adapter.start();
            return adapter;
        } catch (error) {
            await adapter.stop?.().catch(() => null);
            this.context.setResponsesAdapter(null);
            throw new CodexAppServerError('TOOLBOX_ADAPTER_START_FAILED',
                'VCPToolBox Responses adapter failed to start', { cause: error?.message || String(error) });
        }
    }

    async refreshToolboxConfiguration(settings = this.context.getSettings() || {}) {
        const nextFingerprint = toolboxConfigFingerprint(settings);
        if (nextFingerprint === this.toolboxConfigFingerprint && !this.toolboxReconfiguration) {
            return this.context.getStatus();
        }
        if (nextFingerprint !== this.toolboxRequestedFingerprint) {
            this.toolboxRequestedSettings = { ...settings };
            this.toolboxRequestedFingerprint = nextFingerprint;
            this.toolboxRequestedGeneration += 1;
        }
        const targetGeneration = this.toolboxRequestedGeneration;
        if (!this.toolboxReconfiguration) {
            this.toolboxReconfiguration = this.drainToolboxConfiguration().finally(() => {
                this.toolboxReconfiguration = null;
            });
        }
        const result = await this.toolboxReconfiguration;
        if (this.toolboxAppliedGeneration < targetGeneration) {
            return this.refreshToolboxConfiguration(this.toolboxRequestedSettings || settings);
        }
        return result;
    }

    async drainToolboxConfiguration() {
        let lastError = null;
        while (this.toolboxAppliedGeneration < this.toolboxRequestedGeneration) {
            const generation = this.toolboxRequestedGeneration;
            const settings = this.toolboxRequestedSettings || {};
            const fingerprint = this.toolboxRequestedFingerprint;
            try {
                await this.applyToolboxConfiguration(settings, fingerprint);
                lastError = null;
            } catch (error) {
                lastError = error;
            }
            this.toolboxAppliedGeneration = generation;
            if (generation === this.toolboxRequestedGeneration && lastError) throw lastError;
        }
        return this.context.getStatus();
    }

    async applyToolboxConfiguration(settings, nextFingerprint) {
        if (this.context.state() !== 'ready') {
            this.toolboxConfigFingerprint = nextFingerprint;
            return this.context.getStatus();
        }
        const reason = 'VCPToolBox connection settings changed';
        await this.context.failClosedToolboxApprovals(reason);
        await this.context.interruptDynamicCalls(reason);
        this.context.clearInteractions('toolbox');
        this.context.advanceToolboxAuthorityGeneration();
        const oldBridge = this.context.bridge();
        this.context.setBridge(null);
        await oldBridge?.stop().catch((error) => {
            this.context.emitDiagnostic(`Could not stop old ToolBox bridge: ${error.message}`);
        });
        const configured = hasToolboxConfiguration(settings);
        try {
            const adapter = this.context.responsesAdapter();
            if (!configured) {
                await adapter?.stop().catch(() => null);
                this.context.setResponsesAdapter(null);
            } else if (adapter?.reconfigure) {
                await adapter.reconfigure({ toolboxUrl: settings.vcpServerUrl, toolboxApiKey: settings.vcpApiKey });
            } else {
                await adapter?.stop().catch(() => null);
                this.context.setResponsesAdapter(null);
                await this.ensureResponsesAdapter(settings);
            }
            if (configured) await this.ensureBridge(settings);
            this.toolboxConfigFingerprint = nextFingerprint;
            this.context.sendUiEvent({ type: 'toolbox.connection.reconfigured', payload: { configured } });
        } catch (error) {
            await this.context.responsesAdapter()?.stop().catch(() => null);
            this.context.setResponsesAdapter(null);
            this.context.setLastError(serializeError(error));
            this.context.sendUiEvent({
                type: 'runtime.warning',
                payload: { warning: 'VCPToolBox connection update failed; VCP tools are unavailable.' },
            });
            throw error;
        }
        return this.context.getStatus();
    }

    wireTransport() {
        if (this.transportWired) return;
        const transport = this.context.transport();
        if (!transport) throw new CodexAppServerError('RUNTIME_UNAVAILABLE', 'Codex App Server transport is unavailable');
        const operation = this.context.createOperationContext();
        const ownsTransport = () => {
            try {
                this.context.assertOperationContext(operation);
            } catch {
                return false;
            }
            return this.context.transport() === transport;
        };
        this.transportWired = true;
        transport.on('notification', (message) => {
            if (ownsTransport()) this.handleNotification(message);
        });
        transport.on('server-request', (message) => {
            if (!ownsTransport()) return;
            if (message.method === 'item/tool/call') {
                void this.context.handleDynamicToolCall(message);
                return;
            }
            this.context.acceptServerRequest(message);
        });
        transport.on('exit', (error) => {
            if (!ownsTransport() || this.context.intentionalStop()) return;
            void this.handleTransportCrash(error);
        });
        transport.on('stderr', (line) => {
            if (ownsTransport()) this.context.emitDiagnostic(line);
        });
    }

    handleNotification(message) {
        const repository = this.context.repository();
        const threadId = message?.params?.threadId || message?.params?.thread?.id || null;
        const sessionBefore = threadId ? repository?.getSessionByThread(threadId) : null;
        const baseProjectionRevision = sessionBefore
            ? repository.projectionGeneration(sessionBefore.sessionId) : 0;
        const projected = this.context.projector()?.projectNotification(message);
        this.observeCompactionNotification(message);
        const session = threadId ? repository?.getSessionByThread(threadId) : null;
        applySettingsNotification(this.context, repository, session, message);
        this.context.updateThreadState(message, session);
        const itemId = notificationItemId(message);
        const projectionMessage = projected && session && itemId
            ? repository.getProjectedMessageByItem(session.sessionId, itemId) : null;
        const projectionRevision = session ? repository.projectionGeneration(session.sessionId) : baseProjectionRevision;
        const projectionPatch = projectionMessage && projectionRevision > baseProjectionRevision
            ? {
                schemaVersion: 1,
                sessionId: session.sessionId,
                threadId,
                runtimeGeneration: this.context.runtimeGeneration(),
                baseProjectionRevision,
                projectionRevision,
                upsertBlocks: projectionMessage.blocks.map((block) => normalizeTimelineBlock({
                    sessionId: session.sessionId, threadId, message: projectionMessage, block,
                })),
                deleteBlockIds: [],
            } : null;
        const event = notificationEvent(this.context, message, projected, session, threadId, itemId, projectionPatch);
        this.context.sendEvent(event);
    }

    observeCompactionNotification(message) {
        const params = message?.params || {};
        const item = params.item;
        if (!item || item.type !== 'contextCompaction' || !params.threadId) return;
        const waiter = this.context.compactionWaiters().get(params.threadId);
        if (!waiter) return;
        try { this.context.assertOperationContext(waiter.operation); } catch (error) {
            this.context.compactionWaiters().delete(params.threadId);
            clearTimeout(waiter.timeout);
            waiter.reject(error);
            return;
        }
        if (message.method === 'item/started') {
            this.context.sendUiEvent({
                type: 'compaction.started', sessionId: waiter.sessionId,
                payload: { itemId: item.id || null },
            });
            return;
        }
        if (message.method !== 'item/completed') return;
        this.context.compactionWaiters().delete(params.threadId);
        clearTimeout(waiter.timeout);
        const failed = ['failed', 'error', 'cancelled', 'interrupted'].includes(String(item.status || '').toLowerCase());
        if (failed) {
            const error = new CodexAppServerError('COMPACTION_FAILED', item.message || 'Codex context compaction failed');
            waiter.reject(error);
            this.context.sendUiEvent({
                type: 'compaction.failed', sessionId: waiter.sessionId,
                payload: { itemId: item.id || null, reason: error.message },
            });
            return;
        }
        void this.context.readSession({ sessionId: waiter.sessionId }).then((snapshot) => {
            waiter.resolve({ sessionId: waiter.sessionId, threadId: waiter.threadId, itemId: item.id || null, snapshot });
            this.context.sendUiEvent({
                type: 'compaction.completed', sessionId: waiter.sessionId,
                payload: { itemId: item.id || null },
            });
        }).catch((error) => {
            waiter.reject(error);
            this.context.sendUiEvent({
                type: 'compaction.failed', sessionId: waiter.sessionId,
                payload: { itemId: item.id || null, reason: error.message },
            });
        });
    }

    rejectCompactionWaiters(error) {
        for (const [threadId, waiter] of this.context.compactionWaiters()) {
            this.context.compactionWaiters().delete(threadId);
            clearTimeout(waiter.timeout);
            waiter.reject(error);
            this.context.sendUiEvent({
                type: 'compaction.failed', sessionId: waiter.sessionId,
                payload: { reason: error.message },
            });
        }
    }

    async ensureBridge(settings = this.context.getSettings() || {}) {
        const current = this.context.bridge();
        if (current) return current.start();
        const bridgeName = process.platform === 'win32' ? 'vcp-toolbox-bridge.exe' : 'vcp-toolbox-bridge';
        const candidates = [
            process.env.VCP_TOOLBOX_BRIDGE,
            process.resourcesPath && path.join(process.resourcesPath, bridgeName),
            path.join(this.context.projectRoot(), 'rust', 'target', 'release', bridgeName),
        ].filter(Boolean);
        const bridgePath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
        if (!settings.vcpServerUrl || !settings.vcpApiKey || !fs.existsSync(bridgePath)) return null;
        const bridge = this.context.bridgeFactory()({
            projectRoot: this.context.projectRoot(),
            executable: bridgePath,
            env: { VCP_TOOLBOX_URL: settings.vcpServerUrl, VCP_TOOLBOX_API_KEY: settings.vcpApiKey },
        });
        this.context.setBridge(bridge);
        bridge.on('stderr', (line) => {
            if (this.context.bridge() === bridge) this.context.emitDiagnostic(`[toolbox-bridge] ${line}`);
        });
        bridge.on('event', (message) => {
            if (this.context.bridge() === bridge) this.context.handleBridgeEvent(message);
        });
        await bridge.start();
        return bridge;
    }

    async handleTransportCrash(error) {
        this.context.setState('crashed');
        const serialized = serializeError(error);
        this.context.setLastError(serialized);
        this.context.invalidateGeneration('Codex App Server crashed');
        const repository = this.context.repository();
        if (repository && !repository.readOnly) {
            for (const [threadId, threadState] of this.context.threadStates()) {
                if (threadState?.activity !== 'running') continue;
                const session = repository.getSessionByThread(threadId);
                if (!session) continue;
                repository.saveSession({ ...session, state: 'interrupted', updatedAt: Date.now() });
                repository.updateActivity(session.sessionId, {
                    runtimeState: 'crashed',
                    deliveryState: 'unconfirmed',
                    interruptedTurnId: threadState.activeTurnId || null,
                });
            }
        }
        this.context.clearCrashRegistries();
        await this.context.failClosedNativeApprovals('Codex App Server crashed', { respond: false });
        await this.context.failClosedToolboxApprovals('Codex App Server crashed');
        this.context.clearInteractions('codex-native');
        this.context.clearInteractions('toolbox');
        this.rejectCompactionWaiters(new CodexAppServerError(
            'RUNTIME_CRASHED', 'Codex App Server crashed during compaction',
        ));
        await this.context.interruptDynamicCalls('Codex App Server crashed');
        this.context.clearInteractionTimers();
        this.context.setKnownOperationRecoveryPromise(null);
        const transport = this.context.transport();
        const bridge = this.context.bridge();
        const responsesAdapter = this.context.responsesAdapter();
        await transport?.stop?.().catch(() => null);
        await bridge?.stop?.().catch(() => null);
        await responsesAdapter?.stop?.().catch(() => null);
        this.context.repository()?.close();
        this.context.clearHostResources();
        this.reset();
        this.context.setState('crashed');
        this.transportWired = false;
        this.context.sendEvent({ runtime: 'codex', type: 'runtime.crashed', error: serialized });
    }

    reset() {
        this.transportWired = false;
        this.toolboxConfigFingerprint = null;
        this.toolboxReconfiguration = null;
        this.toolboxRequestedSettings = null;
        this.toolboxRequestedFingerprint = null;
        this.toolboxRequestedGeneration = 0;
        this.toolboxAppliedGeneration = 0;
    }
}

module.exports = { RuntimeHostService };
