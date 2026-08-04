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
        this.context = Object.freeze(context);
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

    _requireSubmissionId(submissionId) {
        const value = String(submissionId || '').trim();
        if (!value) throw new CodexAppServerError('INVALID_SUBMISSION_ID', 'Turn command requires a submissionId');
        return value;
    }

    _requireActiveTurn(session, turnId, action) {
        const expectedTurnId = String(turnId || '').trim();
        if (!expectedTurnId) {
            throw new CodexAppServerError('INVALID_TURN_ID', `${action} requires an explicit Codex turnId`);
        }
        const state = this.context.threadStates().get(session.threadId);
        if (state?.activity !== 'running' || state.activeTurnId !== expectedTurnId) {
            throw new CodexAppServerError(
                'STALE_TURN', `${action} target is not the active Turn for this Session`,
                { expectedTurnId, activeTurnId: state?.activeTurnId || null, activity: state?.activity || 'unknown' },
            );
        }
        return expectedTurnId;
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
        const appliedConfig = session.appliedRuntimeConfigRevision === session.configRevision
            ? session.appliedRuntimeConfig : null;
        if (!appliedConfig) {
            throw new CodexAppServerError(
                'SESSION_CONFIG_PENDING', 'Session configuration was not confirmed before turn/start',
            );
        }
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
            model: appliedConfig.model || undefined,
            ...(this.context.effectiveReasoningEffort(appliedConfig)
                ? { effort: this.context.effectiveReasoningEffort(appliedConfig) } : {}),
            approvalPolicy: normalizeApprovalPolicy(
                appliedConfig.permissionMode || appliedConfig.approvalPolicy,
            ),
            sandbox: normalizeSandboxMode(appliedConfig.sandbox),
        });
        repository = this._operationRepository(operation);
        const acceptedTurnId = result?.turn?.id || this.context.createId('turn');
        this.context.idleWarmSessions().delete(session.sessionId);
        this.context.threadStates().set(session.threadId, { activity: 'running', activeTurnId: acceptedTurnId });
        this.context.diagnostic('turn-start-ack', {
            sessionId: session.sessionId,
            turnId: acceptedTurnId,
            durationMs: this.context.diagnosticClock() - startedAt,
        });
        return { sessionId: session.sessionId, threadId: session.threadId, turnId: acceptedTurnId };
    }

    async steer({ sessionId, turnId, prompt, submissionId } = {}) {
        this.context.assertProjectionWritable();
        const session = this.context.repository().getSession(requireSessionId(sessionId));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const expectedTurnId = this._requireActiveTurn(session, turnId, 'turn/steer');
        const text = String(prompt || '').trim();
        if (!text) throw new CodexAppServerError('INVALID_INPUT', 'Steering message must not be empty');
        const stableSubmissionId = this._requireSubmissionId(submissionId);
        const requestKey = `${expectedTurnId}:${stableSubmissionId}`;
        const steerPromises = this.context.steerPromises?.() || new Map();
        const existing = steerPromises.get(session.sessionId);
        if (existing) {
            if (existing.requestKey === requestKey) return existing.promise;
            throw new CodexAppServerError('SESSION_BUSY', 'Another steering command is already being submitted for this Session');
        }
        const promise = this._steerInternal({
            session, turnId: expectedTurnId, prompt: text, submissionId: stableSubmissionId,
        });
        steerPromises.set(session.sessionId, { requestKey, promise });
        try {
            return await promise;
        } finally {
            if (steerPromises.get(session.sessionId)?.promise === promise) steerPromises.delete(session.sessionId);
        }
    }

    async _steerInternal({ session, turnId, prompt, submissionId, pendingInput = null }) {
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId, turnId });
        let repository = this._operationRepository(operation);
        const pending = pendingInput || repository.enqueuePendingInput(session.sessionId, {
            submissionId,
            kind: 'steer',
            targetTurnId: turnId,
            prompt,
        });
        if (!pending) throw new CodexAppServerError('PENDING_INPUT_WRITE_FAILED', 'Could not persist steering command');
        if (!['queued', 'failed'].includes(pending.state)) {
            throw new CodexAppServerError('PENDING_INPUT_BUSY', 'Steering command is already pending confirmation');
        }
        repository.updatePendingInput(pending.inputId, {
            state: 'dispatching', attemptCount: pending.attemptCount + 1, lastError: null,
        });
        try {
            const result = await this.context.transport().request('turn/steer', {
                threadId: session.threadId,
                expectedTurnId: turnId,
                clientUserMessageId: pending.clientMessageId,
                input: [{ type: 'text', text: prompt, text_elements: [] }],
            });
            repository = this._operationRepository(operation);
            repository.updatePendingInput(pending.inputId, {
                state: 'accepted', turnId: result?.turnId || turnId, lastError: null,
            });
            repository.removePendingInput(pending.inputId);
            return {
                sessionId: session.sessionId,
                threadId: session.threadId,
                turnId: result?.turnId || turnId,
                submissionId,
            };
        } catch (error) {
            if (error?.code === 'STALE_RUNTIME_GENERATION') throw error;
            repository = this._operationRepository(operation);
            repository.updatePendingInput(pending.inputId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
    }

    async retrySteerPendingInput(session, pendingInput) {
        if (!session?.sessionId || !pendingInput?.inputId) {
            throw new CodexAppServerError('INVALID_INPUT', 'Steering recovery requires a Session and pending input');
        }
        return this.steer({
            sessionId: session.sessionId,
            turnId: pendingInput.targetTurnId,
            prompt: pendingInput.prompt,
            submissionId: pendingInput.submissionId,
        });
    }

    async followUp({ sessionId, afterTurnId, prompt, submissionId, attachments = [] } = {}) {
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
        const targetTurnId = this._requireActiveTurn(session, afterTurnId, 'follow-up');
        const stableSubmissionId = this._requireSubmissionId(submissionId);
        const queued = repository.enqueuePendingInput(idValue, {
            submissionId: stableSubmissionId,
            kind: 'follow-up',
            targetTurnId,
            prompt: text,
        });
        return {
            sessionId: idValue,
            threadId: session.threadId,
            inputId: queued.inputId,
            submissionId: stableSubmissionId,
            afterTurnId: targetTurnId,
            queued: true,
        };
    }

    async cancel({ sessionId, turnId } = {}) {
        this.context.assertProjectionWritable();
        const session = this.context.repository().getSession(requireSessionId(sessionId));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const expectedTurnId = this._requireActiveTurn(session, turnId, 'turn/interrupt');
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId, turnId: expectedTurnId });
        const cancellationKey = `${session.threadId}:${expectedTurnId}`;
        const cancellations = this.context.turnCancellationStates?.() || new Map();
        const existing = cancellations.get(cancellationKey);
        if (existing) return existing.promise || existing.result || existing;
        const interrupts = [...this.context.dynamicCalls().values()]
            .filter((call) => call.threadId === session.threadId && call.turnId === expectedTurnId)
            .map((call) => Promise.resolve().then(() => this.context.bridge()?.interrupt(call.bridgeRequestId)));
        const promise = (async () => {
            const [appServer, responses, bridge, interactions] = await Promise.allSettled([
                this.context.transport().request('turn/interrupt', {
                    threadId: session.threadId, turnId: expectedTurnId,
                }),
                this.context.responsesAdapter()?.cancelTurn?.({
                    threadId: session.threadId, turnId: expectedTurnId,
                }) || Promise.resolve(0),
                Promise.allSettled(interrupts),
                this.context.failClosedTurnInteractions?.({
                    sessionId: session.sessionId, threadId: session.threadId, turnId: expectedTurnId,
                }, 'The owning Codex Turn was interrupted') || Promise.resolve({ resolved: [] }),
            ]);
            this._operationRepository(operation);
            const result = {
                sessionId: session.sessionId,
                threadId: session.threadId,
                turnId: expectedTurnId,
                state: appServer.status === 'fulfilled' ? 'requested' : 'uncertain',
                interrupted: false,
                channels: {
                    appServer: appServer.status,
                    responses: responses.status,
                    bridge: bridge.status,
                    interactions: interactions.status,
                },
                error: appServer.status === 'rejected'
                    ? (appServer.reason?.message || String(appServer.reason)) : null,
            };
            cancellations.set(cancellationKey, { ...result, result, promise: null, updatedAt: Date.now() });
            return result;
        })();
        cancellations.set(cancellationKey, { state: 'requesting', promise, updatedAt: Date.now() });
        return promise;
    }

    async fork({ sessionId, turnId, beforeTurnId, title } = {}) {
        this.context.assertProjectionWritable();
        let repository = this.context.repository();
        let source = repository.getSession(requireSessionId(sessionId));
        if (!source?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        source = this.context.repairSessionIdentity(this.context.repairSessionConfig(source));
        const config = source.configSnapshot || {};
        const forkBeforeTurnId = String(beforeTurnId || '').trim();
        const forkLastTurnId = String(turnId || '').trim();
        if (forkBeforeTurnId && forkLastTurnId) {
            throw new CodexAppServerError(
                'INVALID_INPUT', 'thread/fork accepts either beforeTurnId or lastTurnId, not both',
            );
        }
        const operationContext = this._operation({
            sessionId: source.sessionId,
            threadId: source.threadId,
            turnId: forkBeforeTurnId || forkLastTurnId || null,
        });
        const targetSessionId = this.context.createId('session');
        const operation = repository.createOperation({
            sessionId: source.sessionId, kind: 'thread-fork',
            payload: {
                targetSessionId,
                sourceThreadId: source.threadId,
                lastTurnId: forkLastTurnId || null,
                beforeTurnId: forkBeforeTurnId || null,
            },
        });
        let threadId;
        try {
            repository.updateOperation(operation.operationId, { state: 'dispatching' });
            const result = await this.context.transport().request('thread/fork', {
                threadId: source.threadId,
                // A fork copies history, not VChat's ephemeral provider
                // binding. Carry the effective toolbox-only configuration so
                // the first replacement Turn uses our Responses adapter.
                model: config.model || undefined,
                ...this.context.runtimePolicyParams(config),
                cwd: source.workspaceRoot || undefined,
                approvalPolicy: normalizeApprovalPolicy(config.permissionMode || config.approvalPolicy),
                sandbox: normalizeSandboxMode(config.sandbox),
                ...this.context.threadInstructionParams(config),
                ...(forkBeforeTurnId ? { beforeTurnId: forkBeforeTurnId }
                    : (forkLastTurnId ? { lastTurnId: forkLastTurnId } : {})),
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
            // `thread/fork` loads the history, but its schema has no
            // `dynamicTools` parameter. Our toolbox-only profile must still
            // run through resume before its first Turn to establish this
            // connection's live subscription and reapply resume-safe policy.
            // Do not mark it resumed here.
            this.context.threadStates().set(threadId, { activity: 'idle', activeTurnId: null });
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
                let activeTurnId = null;
                if (activity === 'running') {
                    try {
                        const read = await this.context.transport().request('thread/read', {
                            threadId, includeTurns: true,
                        });
                        this.context.assertOperationContext(operation);
                        const readThread = read?.thread || read;
                        if (String(readThread?.id || '').trim() !== threadId) {
                            throw new CodexAppServerError(
                                'INVALID_RESPONSE', 'Codex thread/read returned a mismatched Thread',
                            );
                        }
                        const turns = readThread?.turns || [];
                        activeTurnId = [...turns].reverse().find((turn) => (
                            String(turn?.status || '').toLowerCase() === 'inprogress'
                        ))?.id || null;
                    } catch (error) {
                        this.context.diagnostic('thread-active-turn-unresolved', {
                            sessionId: session.sessionId,
                            threadId,
                            error: error?.message || String(error),
                        });
                    }
                }
                this.context.threadStates().set(threadId, { activity, activeTurnId });
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

    async drainFollowUpQueue(session, { completedTurnId = null, forceInputId = null } = {}) {
        const drains = this.context.followUpDrainPromises();
        if (!session?.sessionId || drains.has(session.sessionId)) return drains.get(session?.sessionId) || null;
        const operation = this._operation({ sessionId: session.sessionId, threadId: session.threadId });
        const drain = (async () => {
            const threadState = this.context.threadStates().get(session.threadId);
            if (threadState?.activity !== 'idle' || threadState.activeTurnId) return null;
            let repository = this._operationRepository(operation);
            const next = repository.listPendingInputs(session.sessionId).find((entry) => (
                entry.kind === 'follow-up'
                && entry.state === 'queued'
                && (forceInputId ? entry.inputId === forceInputId
                    : (!entry.targetTurnId || entry.targetTurnId === completedTurnId))
            ));
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
                for (const remaining of repository.listPendingInputs(session.sessionId)) {
                    if (remaining.kind === 'follow-up' && remaining.state === 'queued'
                        && remaining.targetTurnId === next.targetTurnId) {
                        repository.updatePendingInput(remaining.inputId, { targetTurnId: accepted.turnId });
                    }
                }
                this.context.sendUiEvent({
                    type: 'input.dequeued', sessionId: session.sessionId,
                    turnId: accepted.turnId, payload: { inputId: next.inputId },
                });
                return accepted;
            } catch (error) {
                if (error?.simulateProcessCrash === true || error?.code === 'STALE_RUNTIME_GENERATION') throw error;
                repository = this._operationRepository(operation);
                const retryableTurnRace = [
                    'ACTIVE_TURN_NOT_STEERABLE',
                    'TURN_NOT_STEERABLE',
                    'SESSION_BUSY',
                ].includes(String(error?.code || '').toUpperCase())
                    || /active.?turn.*not.?steerable/i.test(String(error?.message || ''));
                const currentThreadState = this.context.threadStates().get(session.threadId);
                const nextState = retryableTurnRace
                    ? (currentThreadState?.activity === 'idle' && !currentThreadState.activeTurnId
                        ? 'queued' : 'uncertain')
                    : (isUncertainRemoteMutation(error) ? 'uncertain' : 'failed');
                repository.updatePendingInput(next.inputId, {
                    state: nextState,
                    lastError: error?.message || String(error),
                });
                if (nextState !== 'queued') this.context.sendUiEvent({
                    type: 'input.queue.failed', sessionId: session.sessionId,
                    payload: { inputId: next.inputId, error: error.message, state: nextState },
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
