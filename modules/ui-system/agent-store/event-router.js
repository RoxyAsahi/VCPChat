import { reduceActivityEvent } from './activity-reducer.js';
import { reduceApprovalEvent } from './approval-reducer.js';
import { reduceEphemeralEvent } from './ephemeral-reducer.js';
import { REJECT_EVENT } from './reducer-shared.js';
import { reduceRuntimeEvent } from './runtime-reducer.js';
import { reduceSessionEvent } from './session-reducer.js';

const ROUTES = new Map([
    ['runtime.state_changed', [reduceRuntimeEvent]],
    ['runtime.crashed', [reduceRuntimeEvent, reduceEphemeralEvent]],
    ['runtime.warning', [reduceRuntimeEvent]],
    ['runtime.readiness', [reduceRuntimeEvent]],
    ['session.created', [reduceSessionEvent]],
    ['session.state_changed', [reduceSessionEvent]],
    ['session.closed', [reduceSessionEvent, reduceEphemeralEvent]],
    ['session.config.saved', [reduceSessionEvent]],
    ['session.config.pending', [reduceSessionEvent]],
    ['session.config.applied', [reduceSessionEvent]],
    ['session.config.failed', [reduceSessionEvent]],
    ['turn.started', [reduceEphemeralEvent]],
    ['turn.completed', [reduceEphemeralEvent]],
    ['turn.failed', [reduceEphemeralEvent]],
    ['turn.cancelled', [reduceEphemeralEvent]],
    ['approval.requested', [reduceApprovalEvent, reduceActivityEvent]],
    ['approval.resolved', [reduceApprovalEvent]],
    ['approval.expired', [reduceApprovalEvent]],
    ['interaction.requested', [reduceApprovalEvent, reduceActivityEvent]],
    ['interaction.resolved', [reduceApprovalEvent]],
    ['interaction.rejected', [reduceApprovalEvent]],
    ['toolbox.ws', [reduceActivityEvent]],
    ['marker.observed', [reduceActivityEvent]],
    ['context.usage', [reduceActivityEvent]],
    ['context.compaction.started', [reduceActivityEvent]],
    ['compaction.started', [reduceActivityEvent]],
    ['context.compaction.completed', [reduceActivityEvent]],
    ['compaction.completed', [reduceActivityEvent]],
    ['context.compaction.failed', [reduceActivityEvent]],
    ['compaction.failed', [reduceActivityEvent]],
    ['plan.updated', [reduceActivityEvent]],
]);

function reducersForEvent(type) {
    return ROUTES.get(type) || [];
}

function reduceEvent(current, event) {
    if (!event || typeof event !== 'object' || !event.type) return current;
    const reducers = reducersForEvent(event.type);
    let next = {
        ...current,
        lastSequence: Math.max(current.lastSequence || 0, Number(event.sequence) || 0),
    };
    for (const reducer of reducers) {
        next = reducer(next, event);
        if (next === REJECT_EVENT) return current;
    }
    return next;
}

export { ROUTES, reduceEvent, reducersForEvent };
