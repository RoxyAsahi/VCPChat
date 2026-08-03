'use strict';

const path = require('path');
const { AgentRuntimeRepository } = require('./repository');
const { SCHEMA_VERSION, migrate } = require('./migrations');

function createAgentRuntimeStore(userDataPath, options = {}) {
    return new AgentRuntimeRepository({
        ...options,
        userDataPath,
        databasePath: options.databasePath || path.join(userDataPath, 'agent-runtime.sqlite'),
    });
}

module.exports = {
    AgentRuntimeRepository,
    createAgentRuntimeStore,
    SCHEMA_VERSION,
    migrate,
};
