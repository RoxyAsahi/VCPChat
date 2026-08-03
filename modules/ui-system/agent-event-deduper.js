const DEFAULT_EVENT_CAPACITY = 512;
const DEFAULT_BUCKET_CAPACITY = 64;

function bucketKey(event = {}) {
    const sessionId = String(event.sessionId || '').trim();
    if (sessionId && sessionId !== 'runtime') return `session:${sessionId}`;
    if (event.type?.startsWith('runtime.') || event.type === 'toolbox.ws') return 'runtime';
    return 'global';
}

export function createAgentEventDeduper({
    eventCapacity = DEFAULT_EVENT_CAPACITY,
    bucketCapacity = DEFAULT_BUCKET_CAPACITY,
} = {}) {
    const buckets = new Map();

    function bucket(event) {
        const key = bucketKey(event);
        let value = buckets.get(key);
        if (!value) {
            while (buckets.size >= bucketCapacity) buckets.delete(buckets.keys().next().value);
            value = { watermark: 0, eventIds: new Map() };
            buckets.set(key, value);
        } else {
            buckets.delete(key);
            buckets.set(key, value);
        }
        return value;
    }

    function accept(event) {
        const eventId = String(event?.eventId || '').trim();
        const sequence = Number(event?.sequence);
        if (!eventId || !Number.isFinite(sequence)) return false;
        const value = bucket(event);
        if (value.eventIds.has(eventId) || sequence <= value.watermark) return false;
        value.watermark = sequence;
        value.eventIds.set(eventId, sequence);
        while (value.eventIds.size > eventCapacity) value.eventIds.delete(value.eventIds.keys().next().value);
        return true;
    }

    function clear() { buckets.clear(); }

    function inspect() {
        return [...buckets.entries()].map(([key, value]) => ({
            key,
            watermark: value.watermark,
            eventCount: value.eventIds.size,
        }));
    }

    return { accept, clear, inspect };
}
