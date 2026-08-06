'use strict';

const { normalizeToolPolicy } = require('./tool-policy');
const { normalizeSkillPolicy } = require('./skill-policy');

const PROFILE_SCHEMA_VERSION = 2;
const SESSION_CONFIG_SCHEMA_VERSION = 2;
const BLOCK_CONTENT_SCHEMA_VERSION = 2;
const APPLY_STATES = new Set(['unmaterialized', 'pending', 'applying', 'applied', 'error']);
const DENIED_KEYS = new Set(['path', 'absolutePath', 'filePath', 'base64', 'buffer', 'transcript']);

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const error = new Error(`${label} must be an object`);
        error.code = 'INVALID_AGENT_DATA';
        throw error;
    }
    return value;
}

function assertSupportedVersion(value, current, label) {
    const version = value == null ? 1 : Number(value);
    if (!Number.isInteger(version) || version < 1 || version > current) {
        const error = new Error(`Unsupported ${label} schema version ${value}`);
        error.code = 'UNSUPPORTED_AGENT_DATA_VERSION';
        throw error;
    }
    return version;
}

function validateNoSensitiveFields(value, label = 'Agent data', trail = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateNoSensitiveFields(item, label, [...trail, String(index)]));
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        if (DENIED_KEYS.has(key)) {
            const error = new Error(`${label} contains forbidden field ${[...trail, key].join('.')}`);
            error.code = 'SENSITIVE_AGENT_DATA';
            throw error;
        }
        validateNoSensitiveFields(item, label, [...trail, key]);
    }
}

function normalizeProfile(profile = {}, profileId = '') {
    const source = assertObject(profile, 'AgentProfile');
    assertSupportedVersion(source.schemaVersion, PROFILE_SCHEMA_VERSION, 'AgentProfile');
    const revision = Number(source.profileRevision ?? source.revision ?? 1);
    if (!Number.isInteger(revision) || revision < 1) throw new Error('AgentProfile revision must be positive');
    const result = {
        ...source,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profileId: String(source.profileId || profileId || '').trim(),
        profileRevision: revision,
        revision,
        executionProfile: 'toolbox-only',
        toolPolicy: normalizeToolPolicy(source.toolPolicy),
        skillPolicy: normalizeSkillPolicy(source.skillPolicy),
    };
    validateNoSensitiveFields(result, 'AgentProfile');
    return result;
}

function normalizeSessionConfig(config = {}) {
    const source = assertObject(config, 'SessionConfig');
    assertSupportedVersion(source.schemaVersion, SESSION_CONFIG_SCHEMA_VERSION, 'SessionConfig');
    const result = {
        ...source,
        schemaVersion: SESSION_CONFIG_SCHEMA_VERSION,
        executionProfile: 'toolbox-only',
        toolPolicy: normalizeToolPolicy(source.toolPolicy),
        skillPolicy: normalizeSkillPolicy(source.skillPolicy),
    };
    validateNoSensitiveFields(result, 'SessionConfig');
    return result;
}

function normalizeApplyState(value, fallback = 'unmaterialized') {
    return APPLY_STATES.has(value) ? value : fallback;
}

module.exports = {
    PROFILE_SCHEMA_VERSION,
    SESSION_CONFIG_SCHEMA_VERSION,
    BLOCK_CONTENT_SCHEMA_VERSION,
    normalizeProfile,
    normalizeSessionConfig,
    normalizeApplyState,
    validateNoSensitiveFields,
};
