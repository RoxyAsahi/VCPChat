'use strict';

const { EVENT_SCHEMA_VERSION, newId, assertEventEnvelope } = require('./contracts');

class SessionEventSequencer {
    constructor(sessionId, runtime) {
        this.sessionId = sessionId;
        this.runtime = runtime;
        this.sequence = 0;
        this.seenEventIds = new Set();
    }

    next(type, payload, correlation = {}) {
        this.sequence += 1;
        const event = {
            schemaVersion: EVENT_SCHEMA_VERSION,
            eventId: newId('evt'),
            sequence: this.sequence,
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
            turnId: correlation.turnId,
            messageId: correlation.messageId,
            toolCallId: correlation.toolCallId,
            approvalId: correlation.approvalId,
            runtime: this.runtime,
            type,
            payload,
        };
        return assertEventEnvelope(event);
    }

    acceptExternal(event) {
        assertEventEnvelope(event);
        if (event.sessionId !== this.sessionId) {
            return { accepted: false, reason: 'session-mismatch' };
        }
        if (this.seenEventIds.has(event.eventId)) {
            return { accepted: false, reason: 'duplicate' };
        }
        if (event.sequence <= this.sequence) {
            return { accepted: false, reason: 'stale-sequence' };
        }
        this.sequence = event.sequence;
        this.seenEventIds.add(event.eventId);
        return { accepted: true };
    }
}

module.exports = {
    SessionEventSequencer,
};
