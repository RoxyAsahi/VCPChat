'use strict';

// Clean-room equivalent of the small overlap-safe primitive in Harnss
// streaming-buffer (MIT, dc1dfd8). The map is process-local and never used as
// a transcript authority; SQLite remains the rendered projection source.
function mergeStreamingChunk(current, incoming) {
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

class StreamingAccumulatorRegistry {
    constructor() {
        this.values = new Map();
    }

    append(key, incoming) {
        const current = this.values.get(key) || '';
        const next = mergeStreamingChunk(current, incoming);
        this.values.set(key, next);
        return next.slice(current.length);
    }

    seed(key, value) {
        this.values.set(key, String(value || ''));
    }

    clear(key) {
        this.values.delete(key);
    }

    clearItem(threadId, itemId) {
        const suffix = `:${threadId}:${itemId}:`;
        for (const key of this.values.keys()) {
            if (key.includes(suffix)) this.values.delete(key);
        }
    }
}

module.exports = { mergeStreamingChunk, StreamingAccumulatorRegistry };
