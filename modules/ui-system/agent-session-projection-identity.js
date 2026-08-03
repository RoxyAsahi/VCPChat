function normalizedSessionId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function requireMatchingProjectionSession(expectedSessionId, projectionSessionId) {
    const expected = normalizedSessionId(expectedSessionId);
    const actual = normalizedSessionId(projectionSessionId);
    if (!expected || actual !== expected) {
        const error = new Error('Projection identity does not match the selected Agent Session');
        error.code = 'SESSION_IDENTITY_MISMATCH';
        throw error;
    }
    return expected;
}

function requireSnapshotSession(snapshot, expectedSessionId) {
    return requireMatchingProjectionSession(expectedSessionId, snapshot?.session?.sessionId);
}

export { requireMatchingProjectionSession, requireSnapshotSession };
