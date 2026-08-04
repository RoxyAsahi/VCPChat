'use strict';

const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');
const {
    explicitAgent,
    hasDurableProjection,
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    normalizeInstructionMode,
    requireSessionId,
    sessionProjection,
    sameIdentity,
} = require('./runtime-normalizers');

class RuntimeSessionService {
    constructor(context) {
        this.context = Object.freeze(context);
    }

    _repository(generation) {
        if (generation) this.context.assertGeneration(generation);
        const repository = this.context.repository();
        if (!repository) throw new CodexAppServerError('RUNTIME_STOPPED', 'Agent projection store is closed');
        return repository;
    }

    _operation(identity = {}) {
        return this.context.createOperationContext(identity);
    }

    _operationRepository(operation) {
        this.context.assertOperationContext(operation);
        return this._repository(operation.generation);
    }

    create(options = {}) {
        this.context.ensureProjectionStore();
        this.context.assertProjectionWritable();
        const sessionId = this.context.createId('session');
        const now = Date.now();
        const agentId = explicitAgent(options.agentId || options.agent) || 'codex';
        const configSnapshot = this.context.configSnapshot({ ...options, agentId });
        if (configSnapshot.instructionMode === 'vchat-identity'
            && !String(configSnapshot.baseInstructions || '').trim()) {
            throw new CodexAppServerError(
                'AGENT_IDENTITY_MISSING',
                `Agent ${agentId} has no system prompt; refusing to start it with the Codex identity`,
            );
        }
        const identity = this.context.resolveCanonicalAgent(agentId, { failOnAmbiguous: true });
        const workspaceRoot = path.resolve(options.workspaceRoot
            || identity?.profile?.workspaceRoot
            || this.context.projectRoot());
        const session = this.context.repository().saveSession({
            sessionId,
            agentId: identity?.catalogId || agentId,
            agentCatalogId: identity?.catalogId || agentId,
            agentNameSnapshot: identity?.name || configSnapshot.agentName || agentId,
            title: String(options.title || 'Codex Agent').trim(),
            workspaceRoot,
            state: 'created',
            configSnapshot,
            configRevision: 1,
            createdAt: now,
            updatedAt: now,
        });
        return sessionProjection(session);
    }

    async read({ sessionId, reconcile = true } = {}) {
        const startedAt = this.context.diagnosticClock();
        this.context.ensureProjectionStore();
        let repository = this.context.repository();
        let session = repository.getSession(requireSessionId(sessionId));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        session = this.context.repairSessionConfig(session);
        const localProjection = repository.readProjection(session.sessionId);
        if (reconcile === false || repository.readOnly) {
            this.context.diagnostic('projection-read-returned', {
                sessionId: session.sessionId,
                durationMs: this.context.diagnosticClock() - startedAt,
            });
            return localProjection;
        }
        await this.context.start();
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId });
        if (session.threadId) {
            try {
                let applied = false;
                for (let attempt = 0; attempt < 3 && !applied; attempt += 1) {
                    repository = this._operationRepository(operation);
                    const projectionGeneration = repository.projectionGeneration(session.sessionId);
                    const result = await this.context.transport().request('thread/read', {
                        threadId: session.threadId,
                        includeTurns: true,
                    });
                    repository = this._operationRepository(operation);
                    applied = this.context.projector().reconcileThread(
                        session.sessionId, result.thread || result, projectionGeneration,
                    ).applied;
                }
                if (!applied) throw new CodexAppServerError(
                    'RECONCILE_GENERATION_CHANGED', 'Projection changed during reconciliation; retry later',
                );
                repository = this._operationRepository(operation);
                if (session.orphaned) repository.markOrphaned(session.sessionId, false);
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.context.repository()) throw error;
                repository = this._operationRepository(operation);
                if (isConfirmedThreadNotFound(error) && hasDurableProjection(localProjection)) {
                    repository.markOrphaned(session.sessionId, true);
                }
                repository.markProjectionError(session.sessionId, error.message);
            }
        }
        repository = this._operationRepository(operation);
        const projection = repository.readProjection(session.sessionId);
        this.context.diagnostic('projection-reconcile-returned', {
            sessionId: session.sessionId,
            durationMs: this.context.diagnosticClock() - startedAt,
        });
        return projection;
    }

    list({ agentId, archived = false } = {}) {
        const startedAt = this.context.diagnosticClock();
        this.context.ensureProjectionStore();
        const requested = explicitAgent(agentId);
        const identity = requested ? this.context.resolveCanonicalAgent(requested, { failOnAmbiguous: true }) : null;
        const sessions = this.context.repository().listSessions({ archived: archived === true })
            .map((session) => this.context.repairSessionIdentity(session))
            .filter((session) => !identity || sameIdentity(
                session.agentCatalogId || session.agentId, identity.catalogId,
            ));
        const result = sessions.map((session) => ({
            id: session.sessionId,
            sessionId: session.sessionId,
            agentId: session.agentId,
            agentCatalogId: session.agentCatalogId || session.agentId,
            agentNameSnapshot: session.agentNameSnapshot || session.configSnapshot?.agentName || session.agentId,
            title: session.title,
            model: session.configSnapshot?.model || null,
            workspaceRoot: session.workspaceRoot,
            state: session.state,
            orphaned: session.orphaned,
            pinnedAt: session.pinnedAt || null,
            archivedAt: session.archivedAt || null,
            updatedAt: session.updatedAt,
        }));
        this.context.diagnostic('projection-list-returned', {
            agentId: identity?.catalogId || requested || 'all',
            count: result.length,
            durationMs: this.context.diagnosticClock() - startedAt,
        });
        return result;
    }

    rename({ sessionId, title } = {}) {
        this.context.assertProjectionWritable();
        const repository = this.context.repository();
        const session = repository.getSession(requireSessionId(sessionId));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        repository.saveSession({ ...session, title: String(title || '').trim(), updatedAt: Date.now() });
        return repository.getSession(session.sessionId);
    }

    async archive({ sessionId } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        let repository = this.context.repository();
        const session = repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        this.context.assertLifecycleIdle(session);
        if (session.threadId) await this.context.start();
        const operationContext = this._operation({ sessionId: idValue, threadId: session.threadId });
        repository = this._operationRepository(operationContext);
        const operation = repository.createOperation({
            sessionId: idValue, kind: 'thread-archive', threadId: session.threadId,
        });
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) await this.context.transport().request('thread/archive', { threadId: session.threadId });
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.context.faultInjection().afterArchiveRemoteApplied?.({ operation, session });
        repository = this._operationRepository(operationContext);
        const archived = repository.archiveSession(idValue);
        this.context.attachments().clearSession(idValue);
        repository.updateOperation(operation.operationId, { state: 'completed', threadId: session.threadId });
        return { sessionId: idValue, threadId: session.threadId, archived: true, session: sessionProjection(archived) };
    }

    async restore({ sessionId } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        let repository = this.context.repository();
        const session = repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        if (!session.archivedAt) {
            return { sessionId: idValue, threadId: session.threadId, restored: false, session: sessionProjection(session) };
        }
        if (session.threadId) await this.context.start();
        const operationContext = this._operation({ sessionId: idValue, threadId: session.threadId });
        repository = this._operationRepository(operationContext);
        const operation = repository.createOperation({
            sessionId: idValue, kind: 'thread-unarchive', threadId: session.threadId,
        });
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) {
                const result = await this.context.transport().request('thread/unarchive', { threadId: session.threadId });
                this.context.assertOperationContext(operationContext);
                const returnedThreadId = String(result?.thread?.id || session.threadId);
                if (returnedThreadId !== session.threadId) {
                    throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/unarchive returned a mismatched thread id');
                }
            }
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.context.faultInjection().afterUnarchiveRemoteApplied?.({ operation, session });
        repository = this._operationRepository(operationContext);
        const restored = repository.unarchiveSession(idValue);
        repository.updateOperation(operation.operationId, { state: 'completed', threadId: session.threadId });
        return { sessionId: idValue, threadId: restored.threadId, restored: true, session: sessionProjection(restored) };
    }

    pin({ sessionId, pinned } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        if (typeof pinned !== 'boolean') throw new CodexAppServerError('INVALID_INPUT', 'Session pin state must be boolean');
        const repository = this.context.repository();
        if (!repository.getSession(idValue)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const updated = repository.setPinned(idValue, pinned);
        return { sessionId: idValue, pinned, session: sessionProjection(updated) };
    }

    importAttachment({ sessionId, path: inputPath } = {}) {
        this.context.ensureProjectionStore();
        const idValue = requireSessionId(sessionId);
        if (!this.context.repository().getSession(idValue)) {
            throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        }
        const resolved = path.resolve(String(inputPath || ''));
        const stat = this.context.statFile(resolved);
        if (!stat.isFile()) throw new CodexAppServerError('INVALID_ATTACHMENT', 'Attachment must be a file');
        if (stat.size > 32 * 1024 * 1024) {
            throw new CodexAppServerError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds 32 MiB');
        }
        return { attachment: this.context.attachments().register(idValue, resolved, stat) };
    }

    async permanentlyDelete({ sessionId } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        let repository = this.context.repository();
        const session = repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        if (!session.archivedAt) throw new CodexAppServerError('SESSION_NOT_ARCHIVED', 'Archive the Session before permanently deleting it');
        this.context.assertLifecycleIdle(session);
        if (this.context.toolboxApprovalCount() > 0) {
            throw new CodexAppServerError('SESSION_HAS_PENDING_APPROVAL', 'Resolve pending ToolBox approval before permanent deletion');
        }
        const blockingInput = repository.listPendingInputs(idValue)
            .find((entry) => ['queued', 'dispatching', 'accepted', 'uncertain'].includes(entry.state));
        if (blockingInput) {
            throw new CodexAppServerError('SESSION_HAS_PENDING_INPUT', 'Resolve queued or uncertain input before permanent deletion');
        }
        if (session.threadId) await this.context.start();
        const operationContext = this._operation({ sessionId: idValue, threadId: session.threadId });
        repository = this._operationRepository(operationContext);
        const operation = repository.createOperation({
            sessionId: idValue, kind: 'thread-delete', threadId: session.threadId,
        });
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) {
                try {
                    await this.context.transport().request('thread/delete', { threadId: session.threadId });
                } catch (error) {
                    if (!isConfirmedThreadNotFound(error)) throw error;
                }
            }
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.context.faultInjection().afterDeleteRemoteApplied?.({ operation, session });
        repository = this._operationRepository(operationContext);
        const receipt = repository.permanentlyDeleteSession(idValue, session.threadId);
        this.context.attachments().clearSession(idValue);
        repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: session.threadId,
            payload: { deletionReceiptId: receipt.receiptId },
        });
        return { deleted: true, receipt };
    }

    export({ sessionId, format = 'markdown' } = {}) {
        this.context.ensureProjectionStore();
        const idValue = requireSessionId(sessionId);
        const projection = this.context.repository().readProjection(idValue);
        if (!projection) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const safeTitle = String(projection.session.title || 'agent-session').replace(/[\\/:*?"<>|]+/g, '-');
        if (format === 'json') {
            return { format, fileName: `${safeTitle}.json`, content: `${JSON.stringify(projection, null, 2)}\n` };
        }
        const lines = [`# ${projection.session.title || 'Agent Session'}`, ''];
        for (const message of projection.messages) {
            lines.push(`## ${message.role || 'unknown'}`, '');
            for (const block of message.blocks || []) {
                const content = block.content || {};
                if (typeof content.text === 'string') lines.push(content.text);
                else if (Array.isArray(content.parts)) {
                    for (const part of content.parts) if (typeof part?.text === 'string') lines.push(part.text);
                } else lines.push('```json', JSON.stringify(content, null, 2), '```');
                lines.push('');
            }
        }
        return { format: 'markdown', fileName: `${safeTitle}.md`, content: `${lines.join('\n').trim()}\n` };
    }
}

module.exports = { RuntimeSessionService };
