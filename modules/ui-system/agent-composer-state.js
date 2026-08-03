const INPUT_MODES = new Set(['follow-up', 'steer']);

function emptyComposerState() {
    return { draft: '', attachments: [], activeInputMode: 'follow-up', scrollAnchor: null };
}

export function createAgentComposerState() {
    const states = new Map();

    const get = (sessionId) => {
        const key = String(sessionId || '').trim();
        if (!key) return emptyComposerState();
        if (!states.has(key)) states.set(key, emptyComposerState());
        return states.get(key);
    };

    return {
        get,
        setDraft(sessionId, draft) {
            get(sessionId).draft = String(draft || '');
            return get(sessionId);
        },
        setAttachments(sessionId, attachments) {
            get(sessionId).attachments = Array.isArray(attachments) ? attachments.map((item) => ({ ...item })) : [];
            return get(sessionId);
        },
        setMode(sessionId, mode) {
            get(sessionId).activeInputMode = INPUT_MODES.has(mode) ? mode : 'follow-up';
            return get(sessionId);
        },
        clearAfterAcceptedSend(sessionId) {
            const state = get(sessionId);
            state.draft = '';
            state.attachments = [];
            return state;
        },
        delete(sessionId) { return states.delete(String(sessionId || '').trim()); },
        clear() { states.clear(); },
        entries() { return [...states.entries()]; },
    };
}

