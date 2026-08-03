'use strict';

const { CodexAppServerError } = require('./appServerTransport');
const {
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    serializeError,
    sessionProjection,
} = require('./runtime-normalizers');

const KNOWN_OPERATION_KINDS = new Set(['thread-archive', 'thread-unarchive', 'thread-delete']);

class RuntimeRecoveryService {
    constructor(context) {
        this.context = Object.freeze({ ...context });
    }

    listOperations() {
        this.context.ensureProjectionStore();
        return this.context.repository().listRecoverableOperations();
    }

    _repository(generation) {
        if (generation) this.context.assertGeneration(generation);
        const repository = this.context.repository();
        if (!repository) {
            throw new CodexAppServerError('RUNTIME_STOPPED', 'Projection repository is not available');
        }
        return repository;
    }

    _operation(identity = {}) { return this.context.createOperationContext(identity); }
    _operationRepository(operation) {
        this.context.assertOperationContext(operation);
        return this._repository(operation.generation);
    }

    async recoverKnownThreadOperations() {
        const repository = this.context.repository();
        if (repository?.readOnly) return { recovered: 0, remaining: 0 };
        if (this.context.recoveryPromise()) return this.context.recoveryPromise();
        const promise = (async () => {
            const operationContext = this._operation();
            const recoverable = this._operationRepository(operationContext).listRecoverableOperations()
                .filter((operation) => KNOWN_OPERATION_KINDS.has(operation.kind))
                .filter((operation) => ['prepared', 'dispatching', 'remote-applied', 'uncertain'].includes(operation.state));
            let recovered = 0;
            for (const operation of recoverable) {
                try {
                    if (await this.recoverKnownThreadOperation(operation, operationContext)) recovered += 1;
                } catch (error) {
                    if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.context.repository()) throw error;
                    this.context.setLastError(serializeError(error));
                    this.context.diagnostic('known-operation-recovery-failed', {
                        operationId: operation.operationId,
                        kind: operation.kind,
                        error: error?.message || String(error),
                    });
                }
            }
            const currentRepository = this._operationRepository(operationContext);
            return {
                recovered,
                remaining: currentRepository.listRecoverableOperations()
                    .filter((operation) => KNOWN_OPERATION_KINDS.has(operation.kind)).length,
            };
        })().finally(() => this.context.setRecoveryPromise(null));
        this.context.setRecoveryPromise(promise);
        return promise;
    }

    async recoverKnownThreadOperation(input, operationContext = this._operation({
        sessionId: input?.sessionId, threadId: input?.threadId,
    })) {
        let repository = this._operationRepository(operationContext);
        let operation = repository.getOperation(input.operationId);
        if (!operation || !KNOWN_OPERATION_KINDS.has(operation.kind)) return false;
        if (operation.state !== 'remote-applied') {
            repository.updateOperation(operation.operationId, { state: 'dispatching', lastError: null });
            try {
                if (operation.threadId) {
                    const method = operation.kind === 'thread-archive' ? 'thread/archive'
                        : operation.kind === 'thread-unarchive' ? 'thread/unarchive' : 'thread/delete';
                    try {
                        await this.context.transport().request(method, { threadId: operation.threadId });
                    } catch (error) {
                        if (operation.kind !== 'thread-delete' || !isConfirmedThreadNotFound(error)) throw error;
                    }
                    repository = this._operationRepository(operationContext);
                }
                operation = repository.updateOperation(operation.operationId, {
                    state: 'remote-applied', threadId: operation.threadId, lastError: null,
                });
            } catch (error) {
                repository = this._operationRepository(operationContext);
                repository.updateOperation(operation.operationId, {
                    state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                    lastError: error?.message || String(error),
                });
                return false;
            }
        }
        repository = this._operationRepository(operationContext);
        operation = repository.getOperation(input.operationId);
        if (!operation || !KNOWN_OPERATION_KINDS.has(operation.kind)) return false;
        const session = operation.sessionId ? repository.getSession(operation.sessionId) : null;
        let payload = operation.payload || {};
        if (operation.kind === 'thread-archive') {
            if (!session) throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Archive recovery Session no longer exists');
            repository.archiveSession(session.sessionId);
        } else if (operation.kind === 'thread-unarchive') {
            if (!session) throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Unarchive recovery Session no longer exists');
            repository.unarchiveSession(session.sessionId);
        } else if (session) {
            const receipt = repository.permanentlyDeleteSession(session.sessionId, operation.threadId);
            payload = { ...payload, deletionReceiptId: receipt.receiptId };
        }
        repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: operation.threadId, payload, lastError: null,
        });
        return true;
    }

    async listStoredThreads(archived, operationContext) {
        const threads = [];
        let cursor = null;
        for (let page = 0; page < 20; page += 1) {
            const result = await this.context.transport().request('thread/list', {
                archived: archived === true, cursor, limit: 100, useStateDbOnly: true,
            });
            if (operationContext) this.context.assertOperationContext(operationContext);
            const data = Array.isArray(result?.data) ? result.data : [];
            threads.push(...data);
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
            if (!cursor) break;
        }
        return threads;
    }

    normalizeUnboundThreadOperations() {
        for (const operation of this.context.repository().listRecoverableOperations()) {
            if (operation.kind !== 'thread-start' && operation.kind !== 'thread-fork') continue;
            if (operation.state === 'prepared') {
                this.context.repository().updateOperation(operation.operationId, {
                    state: 'failed', lastError: 'VChat restarted before the Codex Thread request was dispatched',
                });
            } else if (operation.state === 'dispatching') {
                this.context.repository().updateOperation(operation.operationId, {
                    state: 'uncertain', lastError: 'VChat restarted before the Codex Thread request outcome was recorded',
                });
            }
        }
    }

    async listRecoveryCandidates() {
        this.context.ensureProjectionStore();
        const initialOperations = this.context.repository().listRecoverableOperations()
            .filter((operation) => ['uncertain', 'remote-applied'].includes(operation.state)
                && (operation.kind === 'thread-start' || operation.kind === 'thread-fork'));
        if (!initialOperations.length) return { operations: [], threads: [] };
        await this.context.start();
        const operationContext = this._operation();
        const [active, archived] = await Promise.all([
            this.listStoredThreads(false, operationContext), this.listStoredThreads(true, operationContext),
        ]);
        const repository = this._operationRepository(operationContext);
        const operations = initialOperations.map((operation) => repository.getOperation(operation.operationId))
            .filter((operation) => operation && ['uncertain', 'remote-applied'].includes(operation.state));
        const boundThreadIds = new Set([
            ...repository.listSessions({ archived: false }),
            ...repository.listSessions({ archived: true }),
        ].map((session) => session.threadId).filter(Boolean));
        const seen = new Set();
        const threads = [...active, ...archived]
            .filter((thread) => thread?.id && !boundThreadIds.has(thread.id) && !seen.has(thread.id) && seen.add(thread.id))
            .map((thread) => ({
                threadId: thread.id,
                title: thread.name || thread.preview || thread.id,
                preview: thread.preview || '',
                cwd: thread.cwd || '',
                modelProvider: thread.modelProvider || '',
                archived: archived.some((entry) => entry?.id === thread.id),
                createdAt: Number(thread.createdAt || 0),
                updatedAt: Number(thread.updatedAt || 0),
            }));
        return { operations, threads };
    }

    async resolveRecoveryOperation({ operationId, action, threadId } = {}) {
        this.context.assertProjectionWritable();
        let repository = this.context.repository();
        let operation = repository.getOperation(String(operationId || ''));
        if (!operation || !['uncertain', 'remote-applied'].includes(operation.state)
            || (operation.kind !== 'thread-start' && operation.kind !== 'thread-fork')) {
            throw new CodexAppServerError('INVALID_RECOVERY_OPERATION', 'Only unresolved Thread start/fork operations can be resolved');
        }
        const selectedThreadId = String(threadId || '').trim();
        if (!selectedThreadId) throw new CodexAppServerError('INVALID_INPUT', 'Recovery requires a Codex threadId');
        if (operation.threadId && operation.threadId !== selectedThreadId) {
            throw new CodexAppServerError('RECOVERY_THREAD_MISMATCH', 'Recovery must use the Thread recorded by the acknowledged operation');
        }
        await this.context.start();
        const operationContext = this._operation({ threadId: selectedThreadId });
        repository = this._operationRepository(operationContext);
        operation = repository.getOperation(String(operationId || ''));
        if (!operation || !['uncertain', 'remote-applied'].includes(operation.state)
            || (operation.kind !== 'thread-start' && operation.kind !== 'thread-fork')) {
            throw new CodexAppServerError('INVALID_RECOVERY_OPERATION', 'Recovery operation changed while Runtime started');
        }
        if (operation.threadId && operation.threadId !== selectedThreadId) {
            throw new CodexAppServerError('RECOVERY_THREAD_MISMATCH', 'Recovery operation changed its Codex Thread identity');
        }
        const bound = [...repository.listSessions({ archived: false }), ...repository.listSessions({ archived: true })]
            .find((session) => session.threadId === selectedThreadId);
        if (bound) throw new CodexAppServerError('THREAD_ALREADY_BOUND', 'The selected Codex Thread already belongs to a VChat Session');
        if (action === 'delete') {
            try {
                await this.context.transport().request('thread/delete', { threadId: selectedThreadId });
            } catch (error) {
                if (!isConfirmedThreadNotFound(error)) throw error;
            }
            repository = this._operationRepository(operationContext);
            operation = repository.getOperation(String(operationId || ''));
            if (!operation || !['uncertain', 'remote-applied'].includes(operation.state)) {
                throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Recovery operation changed during Thread deletion');
            }
            repository.updateOperation(operation.operationId, {
                state: 'completed', threadId: selectedThreadId,
                payload: { ...operation.payload, resolution: 'deleted-unbound-thread' }, lastError: null,
            });
            return { operationId: operation.operationId, resolved: true, action: 'delete', threadId: selectedThreadId };
        }
        if (action !== 'bind') throw new CodexAppServerError('INVALID_INPUT', 'Recovery action must be bind or delete');
        const result = await this.context.transport().request('thread/read', { threadId: selectedThreadId, includeTurns: true });
        repository = this._operationRepository(operationContext);
        operation = repository.getOperation(String(operationId || ''));
        if (!operation || !['uncertain', 'remote-applied'].includes(operation.state)) {
            throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Recovery operation changed during Thread read');
        }
        const thread = result?.thread || result;
        if (String(thread?.id || '') !== selectedThreadId) {
            throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/read returned a mismatched Thread');
        }
        const rebound = [...repository.listSessions({ archived: false }), ...repository.listSessions({ archived: true })]
            .find((candidate) => candidate.threadId === selectedThreadId);
        if (rebound) throw new CodexAppServerError('THREAD_ALREADY_BOUND', 'The selected Codex Thread was bound during recovery');
        let session;
        if (operation.kind === 'thread-start') {
            session = repository.getSession(operation.sessionId);
            if (!session || session.threadId) {
                throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'The VChat Session is missing or already materialized');
            }
            session = repository.replaceUnmaterializedThread(session.sessionId, selectedThreadId);
        } else {
            const source = repository.getSession(operation.sessionId);
            const targetSessionId = String(operation.payload?.targetSessionId || '').trim();
            if (!source || !targetSessionId || repository.getSession(targetSessionId)) {
                throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'The fork recovery target is no longer available');
            }
            session = repository.saveSession({
                sessionId: targetSessionId, threadId: selectedThreadId,
                agentId: source.agentId, agentCatalogId: source.agentCatalogId,
                agentNameSnapshot: source.agentNameSnapshot,
                title: thread.name || `${source.title || 'Codex Agent'} (recovered branch)`,
                workspaceRoot: thread.cwd || source.workspaceRoot,
                state: 'ready', configSnapshot: source.configSnapshot, configRevision: source.configRevision,
            });
        }
        const projectionGeneration = repository.projectionGeneration(session.sessionId);
        this.context.projector().reconcileThread(session.sessionId, thread, projectionGeneration);
        repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: selectedThreadId,
            payload: { ...operation.payload, resolution: 'bound-thread', boundSessionId: session.sessionId },
            lastError: null,
        });
        this.context.threadStates().set(selectedThreadId, { activity: 'idle', activeTurnId: null });
        return { operationId: operation.operationId, resolved: true, action: 'bind', threadId: selectedThreadId,
            session: sessionProjection(session) };
    }
}

module.exports = { RuntimeRecoveryService };
