'use strict';

const { CodexProjectionProjector } = require('./projector');

function createRuntimeProjector(runtime, repository) {
    let projector = null;
    projector = new CodexProjectionProjector(repository, {
        scheduleReconcile: async ({ sessionId, itemId, reason }) => {
            if (runtime.projector !== projector || runtime.repository !== repository) return;
            runtime._diagnostic('projection-delta-reconcile', { sessionId, itemId, reason });
            await runtime.sessionService.read({ sessionId, reconcile: true });
        },
    });
    return projector;
}

module.exports = { createRuntimeProjector };
