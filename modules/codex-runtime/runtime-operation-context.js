'use strict';

const normalizeIdentity = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};

function createRuntimeOperationContext(generation, identity = {}) {
    if (!generation || typeof generation.assertCurrent !== 'function') {
        throw new TypeError('RuntimeOperationContext requires a captured lifecycle generation');
    }
    return Object.freeze({
        generation,
        sessionId: normalizeIdentity(identity.sessionId),
        threadId: normalizeIdentity(identity.threadId),
        turnId: normalizeIdentity(identity.turnId),
    });
}

function assertRuntimeOperationIdentity(operation, expected = {}) {
    if (!operation?.generation) throw new TypeError('RuntimeOperationContext is required');
    for (const key of ['sessionId', 'threadId', 'turnId']) {
        const value = normalizeIdentity(expected[key]);
        if (value && operation[key] && operation[key] !== value) {
            const error = new Error(`Runtime operation ${key} changed while it was in flight`);
            error.code = 'RUNTIME_OPERATION_IDENTITY_MISMATCH';
            throw error;
        }
    }
    return operation;
}

module.exports = { createRuntimeOperationContext, assertRuntimeOperationIdentity };
