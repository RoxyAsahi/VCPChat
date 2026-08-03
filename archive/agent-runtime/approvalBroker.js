'use strict';

const { fail, ERROR_CODES } = require('./errors');
const { newId, hashArguments, LIMITS } = require('./contracts');
const { APPROVAL_STATES, TERMINAL_APPROVAL_STATES, transition } = require('./runtimeState');
const { summarizeValue } = require('./secretRedactor');

class ApprovalBroker {
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs || LIMITS.APPROVAL_TIMEOUT_MS;
        this.maxPending = options.maxPending || LIMITS.MAX_PENDING_APPROVALS;
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
        this.hasUi = typeof options.hasUi === 'function' ? options.hasUi : () => true;
        this.pending = new Map();
    }

    pendingCount() {
        return this.pending.size;
    }

    requestApproval(request) {
        if (!this.hasUi()) {
            fail(ERROR_CODES.APPROVAL_DENIED, 'No UI available to approve; failing closed');
        }
        if (this.pending.size >= this.maxPending) {
            fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Too many pending approvals', {
                limit: this.maxPending,
            });
        }
        const approvalId = newId('appr');
        const argumentsHash = hashArguments(request.arguments || {});
        const record = {
            approvalId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            kind: request.kind || 'vcp_tool',
            riskLevel: request.riskLevel || 'high',
            reason: request.reason || '',
            argumentsHash,
            argumentSummary: summarizeValue(request.arguments),
            state: APPROVAL_STATES.PENDING,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.timeoutMs,
            resolve: null,
            timer: null,
        };
        const promise = new Promise((resolve) => {
            record.resolve = resolve;
        });
        record.timer = setTimeout(() => {
            this._resolveRecord(record, APPROVAL_STATES.EXPIRED, {
                decision: 'deny',
                reason: 'approval-timeout',
            });
        }, this.timeoutMs);
        if (typeof record.timer.unref === 'function') {
            record.timer.unref();
        }
        this.pending.set(approvalId, record);
        this.onEvent({
            type: 'approval.requested',
            record: publicRecord(record),
        });
        return { approvalId, argumentsHash, promise };
    }

    respond(approvalId, decision, responderArguments, binding = {}) {
        const record = this.pending.get(approvalId);
        if (!record) {
            fail(ERROR_CODES.APPROVAL_NOT_FOUND, `Approval not found: ${approvalId}`);
        }
        if (TERMINAL_APPROVAL_STATES.has(record.state)) {
            fail(ERROR_CODES.APPROVAL_EXPIRED, `Approval already resolved: ${record.state}`);
        }
        for (const field of ['sessionId', 'turnId', 'toolCallId', 'argumentsHash']) {
            if (decision === 'allow' && binding[field] === undefined) {
                this._resolveRecord(record, APPROVAL_STATES.DENIED, {
                    decision: 'deny',
                    reason: `approval-binding-missing:${field}`,
                });
                fail(ERROR_CODES.APPROVAL_ARGUMENT_MISMATCH,
                    `Approval binding is required for allow: ${field}`);
            }
            if (binding[field] !== undefined && binding[field] !== record[field]) {
                this._resolveRecord(record, APPROVAL_STATES.DENIED, {
                    decision: 'deny',
                    reason: `approval-binding-mismatch:${field}`,
                });
                fail(ERROR_CODES.APPROVAL_ARGUMENT_MISMATCH,
                    `Approval binding differs from request: ${field}`);
            }
        }
        if (decision === 'allow' && responderArguments !== undefined) {
            const responderHash = hashArguments(responderArguments);
            if (responderHash !== record.argumentsHash) {
                this._resolveRecord(record, APPROVAL_STATES.DENIED, {
                    decision: 'deny',
                    reason: 'arguments-changed-after-approval',
                });
                fail(ERROR_CODES.APPROVAL_ARGUMENT_MISMATCH,
                    'Approved arguments differ from requested arguments');
            }
        }
        const allow = decision === 'allow';
        this._resolveRecord(record, allow ? APPROVAL_STATES.APPROVED : APPROVAL_STATES.DENIED, {
            decision: allow ? 'allow' : 'deny',
        });
        return { approvalId, decision: allow ? 'allow' : 'deny' };
    }

    cancelForSession(sessionId, reason = 'session-closed') {
        let count = 0;
        for (const record of this.pending.values()) {
            if (record.sessionId === sessionId) {
                this._resolveRecord(record, APPROVAL_STATES.CANCELLED, {
                    decision: 'deny',
                    reason,
                });
                count += 1;
            }
        }
        return count;
    }

    cancelAll(reason = 'runtime-stopped') {
        let count = 0;
        for (const record of this.pending.values()) {
            this._resolveRecord(record, APPROVAL_STATES.CANCELLED, {
                decision: 'deny',
                reason,
            });
            count += 1;
        }
        return count;
    }

    listPending() {
        return Array.from(this.pending.values()).map(publicRecord);
    }

    _resolveRecord(record, nextState, outcome) {
        if (TERMINAL_APPROVAL_STATES.has(record.state)) {
            return;
        }
        transition('approval', record.state, nextState);
        record.state = nextState;
        record.resolvedAt = Date.now();
        if (record.timer) {
            clearTimeout(record.timer);
            record.timer = null;
        }
        this.pending.delete(record.approvalId);
        this.onEvent({
            type: nextState === APPROVAL_STATES.EXPIRED ? 'approval.expired' : 'approval.resolved',
            record: publicRecord(record),
            outcome,
        });
        if (record.resolve) {
            record.resolve({
                approved: nextState === APPROVAL_STATES.APPROVED,
                state: nextState,
                reason: outcome.reason,
            });
        }
    }
}

function publicRecord(record) {
    return {
        approvalId: record.approvalId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        kind: record.kind,
        riskLevel: record.riskLevel,
        reason: record.reason,
        argumentsHash: record.argumentsHash,
        argumentSummary: record.argumentSummary,
        state: record.state,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        resolvedAt: record.resolvedAt,
    };
}

module.exports = {
    ApprovalBroker,
};
