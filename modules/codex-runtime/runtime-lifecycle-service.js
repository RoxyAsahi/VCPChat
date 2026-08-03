'use strict';

const { RuntimeGeneration } = require('./runtimeGeneration');

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

module.exports = { RuntimeLifecycleService };
