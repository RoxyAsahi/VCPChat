'use strict';

const { LIMITS } = require('./contracts');

class BoundedEventBuffer {
    constructor(sessionId, capacity = LIMITS.MAX_EVENTS_PER_SESSION) {
        this.sessionId = sessionId;
        this.capacity = capacity;
        this.events = [];
        this.droppedCount = 0;
    }

    push(event) {
        this.events.push(event);
        if (this.events.length > this.capacity) {
            this.events.shift();
            this.droppedCount += 1;
        }
        return event;
    }

    since(sequence) {
        return this.events.filter((event) => event.sequence > sequence);
    }

    latest(count = 100) {
        return this.events.slice(-count);
    }

    size() {
        return this.events.length;
    }

    clear() {
        this.events = [];
        this.droppedCount = 0;
    }
}

module.exports = {
    BoundedEventBuffer,
};
