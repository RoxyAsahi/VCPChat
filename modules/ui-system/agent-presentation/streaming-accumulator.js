// Clean-room counterpart to Harnss streaming-buffer (MIT, dc1dfd8). It owns
// only one in-memory text value and is intentionally not a transcript store.

function mergeAgentStreamingChunk(current, incoming) {
    const next = String(incoming || '');
    if (!next) return current;
    if (!current) return next;
    if (next.startsWith(current)) return next;
    if (current.endsWith(next)) return current;

    const maxOverlap = Math.min(200, current.length, next.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (current.endsWith(next.slice(0, overlap))) return current + next.slice(overlap);
    }
    return current + next;
}

function createAgentStreamingAccumulator(initial = '') {
    let value = String(initial || '');
    return {
        append(incoming) {
            value = mergeAgentStreamingChunk(value, String(incoming || ''));
            return value;
        },
        replace(next) {
            value = String(next || '');
            return value;
        },
        get value() {
            return value;
        },
    };
}

export { createAgentStreamingAccumulator, mergeAgentStreamingChunk };
