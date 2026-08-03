'use strict';

const { CodexAppServerError } = require('./appServerTransport');
const { InteractionRegistry } = require('./interactionRegistry');
const {
    failClosedServerRequestResponse,
    serverRequestPolicy,
} = require('./protocolCapabilities');
const {
    approvalEvent,
    approvalProjection,
    approvalResponse,
    interactionExpiry,
    normalizeApprovalDecision,
    normalizeInteractionResponse,
    pendingInputProjection,
    requireSessionId,
    sanitizeInteractionPayload,
    submissionDedupeKey,
} = require('./runtime-normalizers');

class RuntimeInteractionService {
    constructor(context) {
        this.context = context;
        this.serverRequests = new Map();
        this.interactions = new InteractionRegistry();
        this.interactionTimers = new Map();
        this.toolboxApprovals = new Map();
        this.toolboxResponsePromises = new Map();
    }

    clearTimer(requestId) {
        const key = String(requestId);
        const timer = this.interactionTimers.get(key);
        if (timer) clearTimeout(timer);
        this.interactionTimers.delete(key);
    }

    clearTimers() {
        for (const timer of this.interactionTimers.values()) clearTimeout(timer);
        this.interactionTimers.clear();
    }

    acceptServerRequest(message) {
        const request = { ...message, runtimeGeneration: this.context.runtimeGeneration() };
        const threadId = request?.params?.threadId || null;
        const repository = this.context.repository();
        const session = threadId ? repository?.getSessionByThread(threadId) : null;
        const profile = session?.configSnapshot?.executionProfile || 'toolbox-only';
        const policy = serverRequestPolicy(request.method, profile);
        if (policy.state !== 'supported') {
            this.failClosedServerRequest(request, policy.reason);
            return { accepted: false, reason: policy.reason };
        }
        if (!this.context.workbenchMounted()) {
            this.failClosedServerRequest(request, 'VChat Workbench is closed');
            return { accepted: false, reason: 'workbench-closed' };
        }
        const queued = this.interactions.enqueue({
            source: 'codex-native',
            requestId: String(request.id),
            generation: request.runtimeGeneration,
            sessionId: session?.sessionId || null,
            threadId,
            turnId: request?.params?.turnId || null,
            kind: policy.kind || 'approval',
            method: request.method,
            payload: sanitizeInteractionPayload(request.params),
            expiresAtMs: interactionExpiry(request),
        });
        if (!queued.accepted) {
            if (queued.reason === 'capacity') {
                this.failClosedServerRequest(request, 'VChat interaction capacity is exhausted');
            }
            return queued;
        }
        const requestId = String(request.id);
        this.serverRequests.set(requestId, request);
        if (policy.kind === 'native-approval' || policy.kind === 'legacy-native-approval') {
            this.context.sendUiEvent(approvalEvent(requestId, request, repository));
        } else {
            const projection = approvalProjection(requestId, request, repository);
            this.context.sendUiEvent({
                type: 'interaction.requested',
                sessionId: projection.sessionId,
                turnId: projection.turnId,
                payload: queued.record,
            });
        }
        if (queued.record.expiresAtMs) {
            const delay = Math.max(0, queued.record.expiresAtMs - Date.now());
            const timer = setTimeout(() => {
                if (!this.serverRequests.has(requestId)) return;
                this.failClosedServerRequest(request, 'Interaction timed out');
            }, delay);
            timer.unref?.();
            this.interactionTimers.set(requestId, timer);
        }
        return queued;
    }

    async respondApproval({ requestId, approvalId, decision, scope, reason, generation } = {}) {
        const pendingId = String(requestId || approvalId || '');
        if (scope === 'toolbox' || this.toolboxApprovals.has(pendingId)) {
            return this.respondToolboxApproval({ pendingId, decision, reason, generation });
        }
        const request = this.serverRequests.get(pendingId);
        if (!pendingId || !request) throw new CodexAppServerError('NOT_FOUND', 'Approval request is no longer pending');
        if (Number(generation) !== Number(request.runtimeGeneration)) {
            throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'Codex approval belongs to a different runtime generation');
        }
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
            throw new CodexAppServerError('INTERACTION_KIND_MISMATCH', 'This request must be answered through respondInteraction');
        }
        if (!this.interactions.begin('codex-native', pendingId, request.runtimeGeneration)) {
            throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'Codex approval is already being answered');
        }
        const response = approvalResponse(request.method, decision);
        try {
            if (response) this.context.transport()?.respond(pendingId, response);
            else this.context.transport()?.respondError(pendingId, -32002, `Unsupported Codex server request: ${request.method}`);
        } catch (error) {
            this.interactions.rollback('codex-native', pendingId, request.runtimeGeneration);
            throw error;
        }
        this.clearTimer(pendingId);
        this.serverRequests.delete(pendingId);
        this.interactions.complete('codex-native', pendingId, 'completed', request.runtimeGeneration);
        const projection = approvalProjection(pendingId, request, this.context.repository());
        this.context.sendUiEvent({
            type: 'approval.resolved',
            sessionId: projection.sessionId,
            approvalId: pendingId,
            payload: { approvalId: pendingId, decision },
        });
        return { requestId: pendingId, resolved: true };
    }

    async respondToolboxApproval({ pendingId, decision, reason, generation }) {
        const approval = this.toolboxApprovals.get(pendingId);
        if (!approval || approval.expiresAtMs <= Date.now()) {
            this.toolboxApprovals.delete(pendingId);
            throw new CodexAppServerError('NOT_FOUND', 'ToolBox approval is no longer pending');
        }
        if (Number(generation) !== Number(approval.generation)) {
            throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'ToolBox approval belongs to a different authority generation');
        }
        if (!this.interactions.begin('toolbox', pendingId, approval.generation)) {
            throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'ToolBox approval is already being answered');
        }
        const operation = this.context.createOperationContext();
        const bridge = this.context.bridge();
        const responsePromise = Promise.resolve().then(() => bridge?.respondApproval({
                requestId: pendingId,
                approved: normalizeApprovalDecision(decision) === 'accept',
                reason,
            }));
        this.toolboxResponsePromises.set(pendingId, responsePromise);
        let result;
        try {
            result = await responsePromise;
        } catch (error) {
            this.interactions.rollback('toolbox', pendingId, approval.generation);
            throw error;
        } finally {
            if (this.toolboxResponsePromises.get(pendingId) === responsePromise) {
                this.toolboxResponsePromises.delete(pendingId);
            }
        }
        if (!result?.written) {
            this.interactions.rollback('toolbox', pendingId, approval.generation);
            throw new CodexAppServerError('TOOLBOX_APPROVAL_FAILED', result?.error || 'ToolBox approval response was not written');
        }
        this.toolboxApprovals.delete(pendingId);
        this.interactions.complete('toolbox', pendingId, 'completed', approval.generation);
        try {
            this.context.assertOperationContext(operation);
        } catch {
            return { requestId: pendingId, resolved: true, scope: 'toolbox', stale: true };
        }
        if (this.context.bridge() !== bridge) {
            return { requestId: pendingId, resolved: true, scope: 'toolbox', stale: true };
        }
        this.context.sendUiEvent({
            type: 'approval.resolved',
            approvalId: pendingId,
            payload: { approvalId: pendingId, decision, scope: 'toolbox' },
        });
        return { requestId: pendingId, resolved: true, scope: 'toolbox' };
    }

    async respondInteraction({ source = 'codex-native', requestId, kind, response = {}, generation } = {}) {
        const pendingId = String(requestId || '').trim();
        if (source !== 'codex-native') {
            throw new CodexAppServerError('INTERACTION_SOURCE_MISMATCH', 'Only Codex server requests use the interaction response channel');
        }
        const request = this.serverRequests.get(pendingId);
        if (!request) throw new CodexAppServerError('NOT_FOUND', 'Interaction request is no longer pending');
        if (Number(generation) !== Number(request.runtimeGeneration)) {
            throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'Codex interaction belongs to a different runtime generation');
        }
        const policy = serverRequestPolicy(request.method, this.context.profileForRequest(request));
        if (policy.state !== 'supported' || policy.kind !== kind) {
            throw new CodexAppServerError('INTERACTION_KIND_MISMATCH', 'Interaction kind does not match the pending request');
        }
        if (!this.interactions.begin(source, pendingId, request.runtimeGeneration)) {
            throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'Interaction is already being answered');
        }
        try {
            this.context.transport()?.respond(pendingId, normalizeInteractionResponse(request, response));
        } catch (error) {
            this.interactions.rollback(source, pendingId, request.runtimeGeneration);
            throw error;
        }
        this.clearTimer(pendingId);
        this.serverRequests.delete(pendingId);
        this.interactions.complete(source, pendingId, 'completed', request.runtimeGeneration);
        const projection = approvalProjection(pendingId, request, this.context.repository());
        this.context.sendUiEvent({
            type: 'interaction.resolved',
            sessionId: projection.sessionId,
            turnId: projection.turnId,
            payload: { source, requestId: pendingId, kind, state: 'completed' },
        });
        return { requestId: pendingId, resolved: true, kind };
    }

    listQueue({ sessionId } = {}) {
        this.context.ensureProjectionStore();
        const idValue = requireSessionId(sessionId);
        const repository = this.context.repository();
        if (!repository.getSession(idValue)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        return { items: repository.listPendingInputs(idValue).map(pendingInputProjection) };
    }

    replaceQueue({ sessionId, interactions = [] } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        const repository = this.context.repository();
        if (!repository.getSession(idValue)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const requested = new Map((Array.isArray(interactions) ? interactions : []).map((item) => [
            String(item?.inputId || item?.interactionId || ''), item,
        ]).filter(([inputId]) => inputId));
        for (const current of repository.listPendingInputs(idValue)) {
            const next = requested.get(current.inputId);
            if (current.state !== 'queued') continue;
            if (!next) {
                repository.removePendingInput(current.inputId);
                continue;
            }
            const prompt = String(next.prompt || next.text || '').trim();
            if (!prompt) throw new CodexAppServerError('INVALID_INPUT', 'Queued follow-up message must not be empty');
            if (prompt !== current.prompt) {
                repository.updatePendingInput(current.inputId, { prompt, dedupeKey: submissionDedupeKey(prompt, []) });
            }
        }
        return this.listQueue({ sessionId: idValue });
    }

    clearQueue({ sessionId } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        const repository = this.context.repository();
        if (!repository.getSession(idValue)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        for (const current of repository.listPendingInputs(idValue)) {
            if (['queued', 'failed'].includes(current.state)) repository.removePendingInput(current.inputId);
        }
        return this.listQueue({ sessionId: idValue });
    }

    async resolvePendingInput({ sessionId, inputId, action } = {}) {
        this.context.assertProjectionWritable();
        const idValue = requireSessionId(sessionId);
        const repository = this.context.repository();
        const targetId = String(inputId || '').trim();
        if (!repository.getSession(idValue)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const pending = repository.listPendingInputs(idValue).find((entry) => entry.inputId === targetId);
        if (!pending) throw new CodexAppServerError('NOT_FOUND', 'Pending input was not found');
        if (action === 'discard') {
            if (!['queued', 'failed', 'uncertain'].includes(pending.state)) {
                throw new CodexAppServerError('PENDING_INPUT_BUSY', 'Dispatching or accepted input cannot be discarded');
            }
            repository.removePendingInput(targetId);
            return { resolved: true, action, items: repository.listPendingInputs(idValue).map(pendingInputProjection) };
        }
        if (action !== 'resend' || !['failed', 'uncertain'].includes(pending.state)) {
            throw new CodexAppServerError('INVALID_PENDING_INPUT_ACTION',
                'Only failed or uncertain input can be explicitly resent');
        }
        const retried = repository.retryPendingInput(targetId);
        const operation = this.context.createOperationContext({ sessionId: idValue });
        const runtimeSession = await this.context.ensureSessionRuntime({
            sessionId: idValue,
            reason: 'explicit-input-resend',
        });
        this.context.assertOperationContext(operation);
        if (this.context.threadStates().get(runtimeSession.threadId)?.activity !== 'running') {
            await this.context.drainFollowUpQueue(runtimeSession);
            this.context.assertOperationContext(operation);
        }
        const currentRepository = this.context.repository();
        return {
            resolved: true,
            action,
            input: retried ? pendingInputProjection(retried) : null,
            items: currentRepository.listPendingInputs(idValue).map(pendingInputProjection),
        };
    }

    async failClosedNativeApprovals(reason, { respond = true } = {}) {
        for (const [requestId, request] of [...this.serverRequests.entries()]) {
            if (request.method === 'item/tool/call') continue;
            this.serverRequests.delete(requestId);
            this.clearTimer(requestId);
            this.interactions.complete('codex-native', requestId, 'expired', request.runtimeGeneration);
            if (respond) {
                try {
                    this.failClosedServerRequest({ ...request, id: requestId }, reason);
                } catch (error) {
                    this.context.diagnostic(`Could not fail-close Codex request ${requestId}: ${error.message}`);
                }
            }
            const projection = approvalProjection(requestId, request, this.context.repository());
            this.context.sendUiEvent({
                type: 'approval.resolved',
                sessionId: projection.sessionId,
                approvalId: requestId,
                payload: { approvalId: requestId, decision: 'decline', scope: 'codex-native', reason },
            });
        }
    }

    failClosedServerRequest(message, reason) {
        const requestId = String(message?.id || '');
        const response = failClosedServerRequestResponse(message?.method);
        if (response) this.context.transport()?.respond(requestId, response);
        else this.context.transport()?.respondError(requestId, -32002, reason || `Unsupported Codex server request: ${message?.method || '(empty)'}`);
        this.serverRequests.delete(requestId);
        this.clearTimer(requestId);
        this.interactions.complete('codex-native', requestId, 'rejected', message.runtimeGeneration);
        const projection = approvalProjection(requestId, message, this.context.repository());
        this.context.sendUiEvent({
            type: 'interaction.rejected',
            sessionId: projection.sessionId,
            turnId: message?.params?.turnId || null,
            payload: { requestId, method: message?.method || null, reason: reason || 'Unsupported server request' },
        });
    }

    async failClosedToolboxApprovals(reason) {
        const approvals = [...this.toolboxApprovals.values()];
        for (const approval of approvals) {
            const requestId = approval.requestId;
            const inFlight = this.toolboxResponsePromises.get(requestId);
            if (inFlight) await inFlight.catch(() => null);
            if (!this.toolboxApprovals.has(requestId)) continue;
            this.toolboxApprovals.delete(requestId);
            await this.context.bridge()?.respondApproval({ requestId, approved: false, reason }).catch(() => null);
            this.interactions.complete('toolbox', requestId, 'expired', approval.generation);
            this.context.sendUiEvent({
                type: 'approval.resolved',
                approvalId: requestId,
                payload: { approvalId: requestId, decision: 'decline', scope: 'toolbox', reason },
            });
        }
    }
}

module.exports = { RuntimeInteractionService };
