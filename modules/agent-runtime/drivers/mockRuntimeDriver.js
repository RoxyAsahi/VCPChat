'use strict';

const { RUNTIME_KINDS } = require('../contracts');

module.exports = {
    kind: RUNTIME_KINDS.MOCK,
    label: 'Mock Agent (offline)',
    workerDriverEnv: 'mock',
    capabilities: Object.freeze({
        streaming: true,
        reasoning: false,
        toolCalls: true,
        cancellation: true,
        resume: false,
        compaction: false,
    }),
    requiresVcpSettings: false,
};
