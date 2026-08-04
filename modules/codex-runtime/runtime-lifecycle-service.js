'use strict';

class RuntimeGeneration {
    constructor(value) {
        this.value = Number(value || 0);
        this.closed = false;
        this.reason = null;
        this.controller = new AbortController();
    }

    close(reason = 'Runtime generation closed') {
        if (this.closed) return;
        this.closed = true;
        this.reason = String(reason);
        this.controller.abort(this.reason);
    }

    assertCurrent(current, ErrorType = Error) {
        if (!this.closed && Number(current) === this.value) return;
        const error = new ErrorType(
            'STALE_RUNTIME_GENERATION',
            this.reason || 'Runtime operation belongs to an expired generation',
        );
        if (!error.code) error.code = 'STALE_RUNTIME_GENERATION';
        throw error;
    }
}

class RuntimeLifecycleService {
    constructor(initialGeneration = 0) {
        this.generation = Number(initialGeneration) || 0;
        this.scope = new RuntimeGeneration(this.generation);
    }
    begin(reason = 'Runtime superseded by a new generation') {
        this.scope.close(reason);
        this.generation += 1;
        this.scope = new RuntimeGeneration(this.generation);
        return this.scope;
    }
    capture() { return this.scope; }
    assert(scope, ErrorType = Error) {
        scope.assertCurrent(this.generation, ErrorType);
    }
    close(reason) { this.scope.close(reason); }
    invalidate(reason) { this.close(reason); this.generation += 1; }
    get value() { return this.generation; }
}

module.exports = { RuntimeGeneration, RuntimeLifecycleService };
