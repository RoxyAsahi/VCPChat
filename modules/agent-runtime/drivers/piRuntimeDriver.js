'use strict';

const { RUNTIME_KINDS } = require('../contracts');

// Thin driver descriptor. The actual Pi integration lives in the worker
// (agent-runtime/piAdapter.mjs); the main process only needs to know how to
// label and configure the worker transport.
module.exports = {
    kind: RUNTIME_KINDS.PI,
    label: 'Pi Agent Harness',
    workerDriverEnv: 'pi',
    capabilities: Object.freeze({
        streaming: true,
        reasoning: true,
        toolCalls: true,
        cancellation: true,
        resume: false,
        compaction: false,
        localToolCatalog: true,
        capabilityPolicy: true,
        subagents: Object.freeze({
            supported: true,
            integration: 'injected-adapters',
            launchesCli: false,
        }),
        teams: Object.freeze({
            supported: true,
            orchestrationOnly: true,
        }),
        executionBackend: 'vcp-toolbox',
    }),
    requiresVcpSettings: true,
};
