'use strict';

function hasProjectionValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.some(hasProjectionValue);
    if (typeof value === 'object') return Object.values(value).some(hasProjectionValue);
    return true;
}

function mergeProjectionContent(existing, incoming) {
    if (!hasProjectionValue(incoming)) return existing;
    if (Array.isArray(incoming)) return incoming;
    if (!incoming || typeof incoming !== 'object') return incoming;
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const merged = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
        if (!hasProjectionValue(value)) continue;
        merged[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeProjectionContent(base[key], value)
            : value;
    }
    return merged;
}

module.exports = { mergeProjectionContent };
