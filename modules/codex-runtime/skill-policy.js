'use strict';

const SKILL_POLICY_SCHEMA_VERSION = 1;
const SKILL_PRESETS = new Set(['all', 'custom']);

function uniqueStrings(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeSkillPolicy(value = null) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        schemaVersion: SKILL_POLICY_SCHEMA_VERSION,
        preset: SKILL_PRESETS.has(source.preset) ? source.preset : 'all',
        enabledSkillIds: uniqueStrings(source.enabledSkillIds),
    };
}

function isSkillEnabled(policyValue, skillId) {
    const policy = normalizeSkillPolicy(policyValue);
    return policy.preset === 'all' || policy.enabledSkillIds.includes(String(skillId || '').trim());
}

module.exports = {
    SKILL_POLICY_SCHEMA_VERSION,
    isSkillEnabled,
    normalizeSkillPolicy,
};
