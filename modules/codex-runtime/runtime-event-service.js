'use strict';

const crypto = require('crypto');
const { sanitizeInteractionPayload } = require('./runtime-normalizers');

class RuntimeEventService {
    constructor(context) {
        this.context = Object.freeze(context);
        this.sequence = 0;
    }

    rememberIdleWarmSession(sessionId) {
        const idle = this.context.idleWarmSessions();
        if (this.context.maxIdleWarmSessions() <= 0) return;
        idle.delete(sessionId);
        idle.set(sessionId, Date.now());
        while (idle.size > this.context.maxIdleWarmSessions()) {
            const oldest = idle.keys().next().value;
            idle.delete(oldest);
            const evicted = this.context.repository()?.getSession(oldest);
            if (evicted?.threadId) this.context.resumedThreadIds().delete(evicted.threadId);
        }
    }

    updateThreadState(message, session) {
        if (!session?.threadId) return;
        const repository = this.context.repository();
        const durableSession = repository.getSession(session.sessionId) || session;
        const states = this.context.threadStates();
        const previous = states.get(session.threadId) || {
            activity: 'idle', activeTurnId: null, observedThreadStatus: 'idle',
        };
        let next = previous;
        let completedTurnId = null;
        if (message.method === 'turn/started') {
            next = {
                ...previous,
                activity: 'running',
                activeTurnId: message.params?.turn?.id || previous.activeTurnId || null,
                observedThreadStatus: 'active',
            };
        } else if (message.method === 'turn/completed') {
            const eventTurnId = String(message.params?.turn?.id || message.params?.turnId || '').trim();
            if (eventTurnId && previous.activeTurnId === eventTurnId) {
                completedTurnId = eventTurnId;
                next = {
                    ...previous,
                    activity: 'idle',
                    activeTurnId: null,
                    observedThreadStatus: 'idle',
                };
                this.context.turnCancellationStates?.()?.delete(`${session.threadId}:${eventTurnId}`);
            }
        } else if (message.method === 'thread/status/changed') {
            const statusType = String(message.params?.status?.type || 'unknown');
            const active = statusType === 'active';
            // Codex 0.146 may send idle before turn/completed. Status is an
            // observation only; the matching turn/completed is the sole
            // authority that clears activeTurnId and drains follow-ups.
            next = {
                ...previous,
                activity: active || previous.activeTurnId ? 'running' : 'idle',
                observedThreadStatus: statusType,
            };
        }
        states.set(session.threadId, next);
        repository.saveSession({ ...durableSession, state: next.activity, updatedAt: Date.now() });
        if (next.activity === 'idle') this.rememberIdleWarmSession(durableSession.sessionId);
        else this.context.idleWarmSessions().delete(durableSession.sessionId);
        if (completedTurnId && next.activity === 'idle') {
            const latest = repository.getSession(durableSession.sessionId);
            if (latest && latest.appliedRuntimeConfigRevision !== latest.configRevision) {
                this.context.scheduleSessionConfigApply(latest.sessionId);
            }
            void this.context.drainFollowUpQueue(latest || durableSession, { completedTurnId });
        }
    }

    sendUiEvent(event) {
        const repository = this.context.repository();
        if (event.sessionId && repository) {
            if (event.type === 'context.usage') {
                repository.updateActivity(event.sessionId, { usage: sanitizeInteractionPayload(event.payload || {}) });
            } else if (event.type === 'compaction.started') {
                repository.updateActivity(event.sessionId, { compaction: { state: 'started', summary: '', error: '' } });
            } else if (event.type === 'compaction.completed') {
                repository.updateActivity(event.sessionId, { compaction: {
                    state: 'completed', summary: String(event.payload?.summary || '').slice(0, 2_000), error: '',
                } });
            } else if (event.type === 'compaction.failed') {
                repository.updateActivity(event.sessionId, { compaction: {
                    state: 'failed', summary: '', error: String(event.payload?.error || 'Context compaction failed').slice(0, 2_000),
                } });
            }
        }
        this.sequence += 1;
        this.context.sendEvent({
            runtime: 'codex',
            eventId: event.eventId || `codex-ui:${this.sequence}:${crypto.randomUUID()}`,
            sequence: this.sequence,
            timestamp: Date.now(),
            ...event,
        });
    }
}

module.exports = { RuntimeEventService };
