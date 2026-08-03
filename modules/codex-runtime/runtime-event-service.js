'use strict';

const crypto = require('crypto');
const { sanitizeInteractionPayload } = require('./runtime-normalizers');

class RuntimeEventService {
    constructor(context) {
        this.context = Object.freeze({ ...context });
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
        const previous = states.get(session.threadId) || { activity: 'idle', activeTurnId: null };
        let next = previous;
        if (message.method === 'turn/started') {
            next = { activity: 'running', activeTurnId: message.params?.turn?.id || null };
        } else if (message.method === 'turn/completed') {
            next = { activity: 'idle', activeTurnId: null };
        } else if (message.method === 'thread/status/changed') {
            const active = message.params?.status?.type === 'active';
            next = { ...previous, activity: active ? 'running' : 'idle', activeTurnId: active ? previous.activeTurnId : null };
        }
        states.set(session.threadId, next);
        repository.saveSession({ ...durableSession, state: next.activity, updatedAt: Date.now() });
        if (next.activity === 'idle') this.rememberIdleWarmSession(durableSession.sessionId);
        else this.context.idleWarmSessions().delete(durableSession.sessionId);
        if (message.method === 'turn/completed' && next.activity === 'idle') {
            const latest = repository.getSession(durableSession.sessionId);
            if (latest && latest.appliedRuntimeConfigRevision !== latest.configRevision) {
                this.context.scheduleSessionConfigApply(latest.sessionId);
            }
            void this.context.drainFollowUpQueue(latest || durableSession);
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
