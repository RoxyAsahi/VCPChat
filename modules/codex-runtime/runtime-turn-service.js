'use strict';

const { CodexAppServerError } = require('./appServerTransport');
const {
    buildTurnInput,
    hasDurableProjection,
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    normalizeApprovalPolicy,
    normalizeSandboxMode,
    requireSessionId,
    sessionProjection,
    submissionDedupeKey,
    vcpInvokeTool,
} = require('./runtime-normalizers');

class RuntimeTurnService {
    constructor(context) {
        this.context = Object.freeze({ ...context });
    }

    _repository(generation) {
        if (generation) this.context.assertGeneration(generation);
        const repository = this.context.repository();
        if (!repository) throw new CodexAppServerError('RUNTIME_STOPPED', 'Agent projection store is closed');
        return repository;
    }

    _operation(identity = {}) { return this.context.createOperationContext(identity); }
    _operationRepository(operation) {
        this.context.assertOperationContext(operation);
        return this._repository(operation.generation);
    }

    async ensureSessionRuntime({
        sessionId, reason = 'send', recoverPendingInputs = true, ...options
    } = {}) {
        this.context.ensureProjectionStore();
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        const warmPromises = this.context.sessionWarmPromises();
        if (warmPromises.has(idValue)) return warmPromises.get(idValue);
        const warm = (async () => {
            const startedAt = this.context.diagnosticClock();
            this.context.diagnostic('thread-warm-started', { sessionId: idValue, reason });
            await this.context.start();
            const operation = this._operation({ sessionId: idValue });
            let repository = this._operationRepository(operation);
            let session = repository.getSession(idValue);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            if (session.archivedAt) {
                throw new CodexAppServerError('SESSION_ARCHIVED', 'Restore the archived Session before starting a Turn');
            }
            session = this.context.repairSessionIdentity(this.context.repairSessionConfig(session));
            session = session.threadId
                ? await this.resumeSession(session)
                : await this.startThreadForSession(session, options);
            repository = this._operationRepository(operation);
            if (recoverPendingInputs) await this.recoverPendingInputsForSession(session, operation);
            this._operationRepository(operation);
            this.context.rememberIdleWarmSession(session.sessionId);
            this.context.diagnostic('thread-warm-completed', {
                sessionId: session.sessionId,
                reason,
                durationMs: this.context.diagnosticClock() - startedAt,
            });
            return sessionProjection(repository.getSession(session.sessionId) || session);
        })().finally(() => warmPromises.delete(idValue));
        warmPromises.set(idValue, warm);
        return warm;
    }

    async startThreadForSession(session, options = {}) {
        const operationContext = this._operation({ sessionId: session.sessionId });
        let repository = this._operationRepository(operationContext);
        const config = session.configSnapshot || this.context.configSnapshot(options);
        const operation = repository.createOperation({
            sessionId: session.sessionId,
            kind: 'thread-start',
            payload: { workspaceRoot: session.workspaceRoot, profileRevision: config.profileRevision || null },
        });
        let threadId;
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            const result = await this.context.transport().request('thread/start', {
                model: config.model || options.model,
                ...this.context.runtimePolicyParams(config, { starting: true }),
                cwd: session.workspaceRoot,
                approvalPolicy: normalizeApprovalPolicy(config.permissionMode || config.approvalPolicy),
                sandbox: normalizeSandboxMode(config.sandbox),
                ...this.context.threadInstructionParams(config),
                dynamicTools: [vcpInvokeTool()],
            });
            repository = this._operationRepository(operationContext);
            threadId = result?.thread?.id;
            if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/start returned no thread id');
            repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId });
            await this.context.faultInjection().afterThreadStartRemoteApplied?.({ operation, session, threadId });
            repository = this._operationRepository(operationContext);
            session = session.threadId
                ? repository.replaceUnmaterializedThread(session.sessionId, threadId)
                : repository.saveSession({ ...session, threadId, state: 'ready', updatedAt: Date.now() });
            session = repository.markSessionConfigApplied(
                session.sessionId, session.configRevision, session.configSnapshot,
            );
            this.context.sendSessionConfigEvent('session.config.applied', session);
            repository.updateOperation(operation.operationId, { state: 'completed', threadId });
        } catch (error) {
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, {
                state: (threadId || isUncertainRemoteMutation(error)) ? 'uncertain' : 'failed',
                threadId: threadId || null,
                lastError: error?.message || String(error),
            });
            throw error;
        }
        this.context.threadStates().set(threadId, { activity: 'idle', activeTurnId: null });
        this.context.resumedThreadIds().add(threadId);
        return session;
    }

    async startTurn(input = {}) {
        return this.startTurnWithGuard({ ...input, recoverPendingInputs: true });
    }

    async startTurnWithGuard({
        sessionId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs,
    } = {}) {
        this.context.assertProjectionWritable();
        const requestedSessionId = requireSessionId(sessionId);
        const text = String(prompt || '').trim();
        const requestKey = submissionDedupeKey(text, attachments);
        const startPromises = this.context.turnStartPromises();
        const existing = startPromises.get(requestedSessionId);
        if (existing) {
            if (existing.requestKey === requestKey) return existing.promise;
            throw new CodexAppServerError('SESSION_BUSY', 'A different message is already being submitted for this Session');
        }
        const override = this.context.startTurnOverride?.();
        const promise = override && override !== this.context.defaultStartTurnMethod?.()
            ? override({ sessionId: requestedSessionId, prompt: text, attachments, clientUserMessageId, recoverPendingInputs })
            : this.startTurnInternal({
            sessionId: requestedSessionId, prompt: text, attachments, clientUserMessageId, recoverPendingInputs,
        });
        startPromises.set(requestedSessionId, { requestKey, promise });
        try {
            return await promise;
        } finally {
            if (startPromises.get(requestedSessionId)?.promise === promise) startPromises.delete(requestedSessionId);
        }
    }

    async startTurnInternal({
        sessionId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs = true,
    } = {}) {
        this.context.assertProjectionWritable();
        const startedAt = this.context.diagnosticClock();
        let session = await this.ensureSessionRuntime({ sessionId, reason: 'send', recoverPendingInputs });
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId });
        await this.context.applySessionRuntimeConfig(session.sessionId, { barrier: true });
        let repository = this._operationRepository(operation);
        session = sessionProjection(repository.getSession(session.sessionId));
        const text = String(prompt || '').trim();
        if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Prompt or attachment must not be empty');
        }
        const resolvedAttachments = this.context.attachments().resolveMany(session.sessionId, attachments);
        const result = await this.context.transport().request('turn/start', {
            threadId: session.threadId,
            clientUserMessageId: clientUserMessageId || this.context.createId('client_msg'),
            input: buildTurnInput(text, resolvedAttachments),
            cwd: session.workspaceRoot,
            model: session.configSnapshot?.model || undefined,
            ...(this.context.effectiveReasoningEffort(session.configSnapshot || {})
                ? { effort: this.context.effectiveReasoningEffort(session.configSnapshot || {}) } : {}),
            approvalPolicy: normalizeApprovalPolicy(
                session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy,
            ),
            sandbox: normalizeSandboxMode(session.configSnapshot?.sandbox),
        });
        repository = this._operationRepository(operation);
        const acceptedTurnId = result?.turn?.id || this.context.createId('turn');
        const appliedSession = repository.markSessionConfigApplied(
            session.sessionId, session.configRevision, session.configSnapshot,
        );
        this.context.configApplyTargets().delete(session.threadId);
        this.context.sendSessionConfigEvent('session.config.applied', appliedSession);
        this.context.idleWarmSessions().delete(session.sessionId);
        this.context.threadStates().set(session.threadId, { activity: 'running', activeTurnId: acceptedTurnId });
        this.context.diagnostic('turn-start-ack', {
            sessionId: session.sessionId,
            turnId: acceptedTurnId,
            durationMs: this.context.diagnosticClock() - startedAt,
        });
        return { sessionId: session.sessionId, threadId: session.threadId, turnId: acceptedTurnId };
    }

    async steer({ sessionId, turnId, prompt } = {}) {
        this.context.assertProjectionWritable();
        const session = this.context.repository().getSession(requireSessionId(sessionId));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId, turnId });
        const result = await this.context.transport().request('turn/steer', {
            threadId: session.threadId,
            expectedTurnId: turnId,
            clientUserMessageId: this.context.createId('client_msg'),
            input: [{ type: 'text', text: String(prompt || ''), text_elements: [] }],
        });
        this._operationRepository(operation);
        return { sessionId: session.sessionId, threadId: session.threadId, turnId: result?.turnId || turnId };
    }

    async followUp({ sessionId, prompt, attachments = [] } = {}) {
        this.context.assertProjectionWritable();
        if (Array.isArray(attachments) && attachments.length) {
            throw new CodexAppServerError(
                'QUEUE_ATTACHMENT_UNSUPPORTED', 'Queued follow-up attachments are not persisted; send them as a new turn instead',
            );
        }
        const idValue = requireSessionId(sessionId);
        const repository = this.context.repository();
        const session = repository.getSession(idValue);
        const text = String(prompt || '').trim();
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        if (!text) throw new CodexAppServerError('INVALID_INPUT', 'Follow-up message must not be empty');
        const queued = repository.enqueuePendingInput(idValue, { dedupeKey: submissionDedupeKey(text, []), prompt: text });
        if (this.context.threadStates().get(session.threadId)?.activity !== 'running') void this.drainFollowUpQueue(session);
        return { sessionId: idValue, threadId: session.threadId, inputId: queued.input_id, queued: true };
    }

    async cancel({ sessionId, turnId } = {}) {
        this.context.assertProjectionWritable();
        const session = this.context.repository().getSession(requireSessionId(sessionId));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId, turnId });
        await this.context.transport().request('turn/interrupt', { threadId: session.threadId, turnId });
        this.context.assertOperationContext(operation);
        await this.context.responsesAdapter()?.cancelTurn?.({ threadId: session.threadId, turnId });
        this.context.assertOperationContext(operation);
        const interrupts = [...this.context.dynamicCalls().values()]
            .filter((call) => call.threadId === session.threadId && (!turnId || call.turnId === turnId))
            .map((call) => this.context.bridge()?.interrupt(call.bridgeRequestId).catch(() => false));
        await Promise.all(interrupts);
        this._operationRepository(operation);
        return { sessionId: session.sessionId, threadId: session.threadId, turnId, interrupted: true };
    }

    async fork({ sessionId, turnId, title } = {}) {
        this.context.assertProjectionWritable();
        let repository = this.context.repository();
        const source = repository.getSession(requireSessionId(sessionId));
        if (!source?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const operationContext = this._operation({
            sessionId: source.sessionId, threadId: source.threadId, turnId,
        });
        const targetSessionId = this.context.createId('session');
        const operation = repository.createOperation({
            sessionId: source.sessionId, kind: 'thread-fork',
            payload: { targetSessionId, sourceThreadId: source.threadId, lastTurnId: turnId || null },
        });
        let threadId;
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            const result = await this.context.transport().request('thread/fork', {
                threadId: source.threadId, ...(turnId ? { lastTurnId: turnId } : {}),
            });
            repository = this._operationRepository(operationContext);
            threadId = result?.thread?.id;
            if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/fork returned no thread id');
            repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId });
            await this.context.faultInjection().afterThreadForkRemoteApplied?.({
                operation, source, threadId, targetSessionId,
            });
            repository = this._operationRepository(operationContext);
            const fork = repository.saveSession({
                sessionId: targetSessionId,
                threadId,
                agentId: source.agentId,
                agentCatalogId: source.agentCatalogId,
                agentNameSnapshot: source.agentNameSnapshot,
                title: title || `${source.title || 'Codex Agent'} (branch)`,
                workspaceRoot: source.workspaceRoot,
                state: 'ready',
                configSnapshot: source.configSnapshot,
                configRevision: source.configRevision,
            });
            repository.updateOperation(operation.operationId, { state: 'completed', threadId });
            return fork;
        } catch (error) {
            repository = this._operationRepository(operationContext);
            repository.updateOperation(operation.operationId, {
                state: (threadId || isUncertainRemoteMutation(error)) ? 'uncertain' : 'failed',
                threadId: threadId || null,
                lastError: error?.message || String(error),
            });
            throw error;
        }
    }

    async compact({ sessionId, timeoutMs = 120_000 } = {}) {
        this.context.assertProjectionWritable();
        const session = this.context.repository().getSession(requireSessionId(sessionId));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        this.context.assertLifecycleIdle(session);
        const waiters = this.context.compactionWaiters();
        if (waiters.has(session.threadId)) {
            throw new CodexAppServerError('SESSION_BUSY', 'Context compaction is already running for this Session');
        }
        await this.context.start();
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId });
        let resolveWaiter;
        let rejectWaiter;
        const completion = new Promise((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
        const timeout = setTimeout(() => {
            const waiter = waiters.get(session.threadId);
            if (!waiter || waiter.operation !== operation) return;
            waiters.delete(session.threadId);
            waiter.reject(new CodexAppServerError('COMPACTION_TIMEOUT', 'Codex context compaction did not complete in time'));
            this.context.sendUiEvent({
                type: 'compaction.failed', sessionId: session.sessionId,
                payload: { reason: 'timeout' },
            });
        }, Math.max(1_000, Number(timeoutMs) || 120_000));
        waiters.set(session.threadId, {
            sessionId: session.sessionId, threadId: session.threadId,
            resolve: resolveWaiter, reject: rejectWaiter, timeout, operation,
        });
        this.context.sendUiEvent({ type: 'compaction.started', sessionId: session.sessionId });
        try {
            await this.context.transport().request('thread/compact/start', { threadId: session.threadId });
            this.context.assertOperationContext(operation);
        } catch (error) {
            const waiter = waiters.get(session.threadId);
            if (waiter?.operation === operation) {
                waiters.delete(session.threadId);
                clearTimeout(waiter.timeout);
                waiter.reject(error);
            }
            throw error;
        }
        return completion;
    }

    async resumeSession(session) {
        const threadId = String(session?.threadId || '').trim();
        if (!threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached to a Codex Thread');
        const operation = this._operation({ sessionId: session.sessionId, threadId });
        const resumed = this.context.resumedThreadIds();
        const resuming = this.context.resumingThreads();
        if (resumed.has(threadId)) return this._operationRepository(operation).getSession(session.sessionId) || session;
        if (resuming.has(threadId)) return resuming.get(threadId);
        const promise = (async () => {
            const config = session.configSnapshot || {};
            try {
                const result = await this.context.transport().request('thread/resume', {
                    threadId,
                    model: config.model || undefined,
                    ...this.context.runtimePolicyParams(config),
                    cwd: session.workspaceRoot || undefined,
                    approvalPolicy: normalizeApprovalPolicy(config.permissionMode || config.approvalPolicy),
                    sandbox: normalizeSandboxMode(config.sandbox),
                    ...this.context.threadInstructionParams(config),
                    ...(config.executionProfile === 'toolbox-only' ? { dynamicTools: [vcpInvokeTool()] } : {}),
                    excludeTurns: true,
                });
                const repository = this._operationRepository(operation);
                const resumedThreadId = String(result?.thread?.id || '').trim();
                if (resumedThreadId !== threadId) {
                    throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/resume returned a mismatched thread id');
                }
                const activity = result?.thread?.status?.type === 'active' ? 'running' : 'idle';
                this.context.threadStates().set(threadId, { activity, activeTurnId: null });
                resumed.add(threadId);
                const applied = repository.markSessionConfigApplied(
                    session.sessionId, session.configRevision, session.configSnapshot,
                );
                this.context.configApplyTargets().delete(threadId);
                this.context.sendSessionConfigEvent('session.config.applied', applied);
                if (session.orphaned) repository.markOrphaned(session.sessionId, false);
                return repository.getSession(session.sessionId) || applied || session;
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.context.repository()) throw error;
                const repository = this._operationRepository(operation);
                const projection = repository.readProjection(session.sessionId);
                if (isConfirmedThreadNotFound(error) && !hasDurableProjection(projection)) {
                    return this.startThreadForSession(session);
                }
                if (isConfirmedThreadNotFound(error)) repository.markOrphaned(session.sessionId, true);
                repository.markProjectionError(session.sessionId, error.message);
                throw error;
            } finally {
                resuming.delete(threadId);
            }
        })();
        resuming.set(threadId, promise);
        return promise;
    }

    async drainFollowUpQueue(session) {
        const drains = this.context.followUpDrainPromises();
        if (!session?.sessionId || drains.has(session.sessionId)) return drains.get(session?.sessionId) || null;
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId });
        const drain = (async () => {
            if (this.context.threadStates().get(session.threadId)?.activity === 'running') return null;
            let repository = this._operationRepository(operation);
            const next = repository.listPendingInputs(session.sessionId).find((entry) => entry.state === 'queued');
            if (!next) return null;
            repository.updatePendingInput(next.inputId, {
                state: 'dispatching', attemptCount: next.attemptCount + 1, lastError: null,
            });
            try {
                await this.context.faultInjection().beforePendingInputRpc?.({ session, pendingInput: next });
                this.context.assertOperationContext(operation);
                const accepted = await this.startTurnWithGuard({
                    sessionId: session.sessionId,
                    prompt: next.prompt,
                    clientUserMessageId: next.clientMessageId,
                    recoverPendingInputs: false,
                });
                await this.context.faultInjection().afterTurnAckBeforePendingCommit?.({ session, pendingInput: next, accepted });
                repository = this._operationRepository(operation);
                repository.updatePendingInput(next.inputId, { state: 'accepted', turnId: accepted.turnId, lastError: null });
                repository.removePendingInput(next.inputId);
                this.context.sendUiEvent({
                    type: 'input.dequeued', sessionId: session.sessionId,
                    turnId: accepted.turnId, payload: { inputId: next.inputId },
                });
                return accepted;
            } catch (error) {
                if (error?.simulateProcessCrash === true || error?.code === 'STALE_RUNTIME_GENERATION') throw error;
                repository = this._operationRepository(operation);
                repository.updatePendingInput(next.inputId, {
                    state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                    lastError: error?.message || String(error),
                });
                this.context.sendUiEvent({
                    type: 'input.queue.failed', sessionId: session.sessionId,
                    payload: { inputId: next.inputId, error: error.message },
                });
                return null;
            }
        })().finally(() => drains.delete(session.sessionId));
        drains.set(session.sessionId, drain);
        return drain;
    }

    async recoverPendingInputsForSession(session, operation = this._operation({
        sessionId: session?.sessionId, threadId: session?.threadId,
    })) {
        let repository = this._operationRepository(operation);
        const pending = repository.listPendingInputs(session.sessionId)
            .filter((entry) => ['dispatching', 'accepted'].includes(entry.state));
        if (!pending.length || !session.threadId) return;
        let thread;
        try {
            const result = await this.context.transport().request('thread/read', {
                threadId: session.threadId, includeTurns: true,
            });
            repository = this._operationRepository(operation);
            thread = result?.thread || result;
        } catch (error) {
            repository = this._operationRepository(operation);
            for (const entry of pending) repository.updatePendingInput(entry.inputId, {
                state: 'uncertain', lastError: `Could not verify accepted input: ${error.message}`,
            });
            return;
        }
        const userItems = (thread?.turns || []).flatMap((turn) => (turn.items || []).map((item) => ({ turn, item })))
            .filter(({ item }) => item?.type === 'userMessage');
        for (const entry of pending) {
            const match = userItems.find(({ item }) => [item.id, item.clientUserMessageId, item.client_user_message_id]
                .some((value) => String(value || '') === String(entry.clientMessageId || '')));
            if (match) {
                repository.updatePendingInput(entry.inputId, {
                    state: 'accepted', turnId: match.turn?.id || entry.turnId || null, lastError: null,
                });
                repository.removePendingInput(entry.inputId);
            } else {
                repository.updatePendingInput(entry.inputId, {
                    state: 'uncertain', lastError: 'Codex Thread does not confirm whether this input was accepted',
                });
            }
        }
    }
}

module.exports = { RuntimeTurnService };
