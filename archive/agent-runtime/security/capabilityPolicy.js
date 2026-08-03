'use strict';

const crypto = require('crypto');
const path = require('path');
const { stableStringify } = require('../contracts');

const EFFECTS = new Set(['allow', 'deny']);
const DEFAULT_DENIED_ACTIONS = Object.freeze(['write', 'shell', 'subagent']);

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeStringList(value, fallback = ['*']) {
    const source = value === undefined ? fallback : value;
    const list = Array.isArray(source) ? source : [source];
    return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function normalizeRule(rule, index) {
    if (!rule || typeof rule !== 'object') {
        throw new TypeError(`Capability rule ${index} must be an object`);
    }
    const effect = String(rule.effect || '').toLowerCase();
    if (!EFFECTS.has(effect)) {
        throw new TypeError(`Capability rule ${index} requires effect allow or deny`);
    }
    return Object.freeze({
        id: String(rule.id || `rule-${index + 1}`),
        effect,
        sessions: normalizeStringList(rule.sessions || rule.session),
        tools: normalizeStringList(rule.tools || rule.tool),
        actions: normalizeStringList(rule.actions || rule.action),
        paths: normalizeStringList(rule.paths || rule.path),
        expiresAt: rule.expiresAt ? new Date(rule.expiresAt).toISOString() : null,
    });
}

function wildcardMatch(pattern, value) {
    if (pattern === '*') return true;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${escaped}$`, 'i').test(value);
}

function listMatches(patterns, value) {
    return patterns.some((pattern) => wildcardMatch(pattern, String(value || '')));
}

function normalizeCandidatePath(candidate) {
    return path.resolve(String(candidate)).replaceAll('\\', '/');
}

function pathMatches(patterns, candidate) {
    if (candidate === undefined || candidate === null || candidate === '') {
        return patterns.includes('*');
    }
    const normalized = normalizeCandidatePath(candidate);
    return patterns.some((pattern) => {
        if (pattern === '*') return true;
        const normalizedPattern = path.resolve(pattern).replaceAll('\\', '/');
        return wildcardMatch(normalizedPattern, normalized);
    });
}

function isExpired(rule, now) {
    return Boolean(rule.expiresAt && Date.parse(rule.expiresAt) <= now.getTime());
}

function matches(rule, request, now) {
    return !isExpired(rule, now)
        && listMatches(rule.sessions, request.sessionId)
        && listMatches(rule.tools, request.toolId)
        && listMatches(rule.actions, request.action)
        && pathMatches(rule.paths, request.path);
}

function bindRulesToSession(rules, sessionId) {
    return (rules || []).map((rule) => ({
        ...rule,
        sessions: rule.sessions || rule.session || [sessionId],
    }));
}

class CapabilityPolicy {
    constructor(options = {}) {
        this.clock = options.clock || (() => new Date());
        this.rules = (options.rules || []).map(normalizeRule);
        this.defaultDeniedActions = normalizeStringList(options.defaultDeniedActions, DEFAULT_DENIED_ACTIONS);
    }

    evaluate(request = {}) {
        const normalized = {
            sessionId: String(request.sessionId || ''),
            toolId: String(request.toolId || ''),
            action: String(request.action || ''),
            path: request.path === undefined ? null : String(request.path),
        };
        if (!normalized.sessionId || !normalized.toolId || !normalized.action) {
            return { allowed: false, effect: 'deny', reason: 'invalid-request', matchedRuleIds: [] };
        }
        const now = this.clock();
        const matching = this.rules.filter((rule) => matches(rule, normalized, now));
        const denies = matching.filter((rule) => rule.effect === 'deny');
        if (denies.length > 0) {
            return { allowed: false, effect: 'deny', reason: 'explicit-deny', matchedRuleIds: denies.map((rule) => rule.id) };
        }
        const allows = matching.filter((rule) => rule.effect === 'allow');
        if (allows.length > 0) {
            return { allowed: true, effect: 'allow', reason: 'explicit-allow', matchedRuleIds: allows.map((rule) => rule.id) };
        }
        const sensitive = this.defaultDeniedActions.some((pattern) => wildcardMatch(pattern, normalized.action));
        return {
            allowed: false,
            effect: 'deny',
            reason: sensitive ? 'sensitive-default-deny' : 'undeclared-default-deny',
            matchedRuleIds: [],
        };
    }

    snapshot() {
        const body = {
            schemaVersion: 1,
            enforcementBoundary: 'client-constraint-not-server-boundary',
            denyPrecedence: true,
            defaultEffect: 'deny',
            defaultDeniedActions: [...this.defaultDeniedActions],
            rules: copy(this.rules),
        };
        return {
            ...body,
            hash: crypto.createHash('sha256').update(stableStringify(body)).digest('hex'),
        };
    }

    static fromSnapshot(snapshot, options = {}) {
        if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rules)) {
            throw new TypeError('Invalid capability policy snapshot');
        }
        const policy = new CapabilityPolicy({
            ...options,
            rules: snapshot.rules,
            defaultDeniedActions: snapshot.defaultDeniedActions,
        });
        if (snapshot.hash && policy.snapshot().hash !== snapshot.hash) {
            throw new Error('Capability policy snapshot hash mismatch');
        }
        return policy;
    }

    static forSession(sessionId, metadata = {}, options = {}) {
        const snapshot = metadata.capabilityPolicy;
        if (snapshot && snapshot.schemaVersion === 1) return CapabilityPolicy.fromSnapshot(snapshot, options);
        const declared = metadata.capabilities || metadata.capabilityRules;
        const rules = declared || [{
            id: 'default-agent-tools',
            effect: 'allow',
            tools: [
                'workspace_propose_patch', 'workspace_apply_patch', 'workspace_revert_patch',
                'vcp_delegate', 'vcp_invoke',
                'spawn_agent', 'await_agent', 'cancel_agent',
            ],
            actions: ['*'],
            paths: ['*'],
        }];
        return new CapabilityPolicy({
            ...options,
            rules: bindRulesToSession(rules, sessionId),
            defaultDeniedActions: metadata.defaultDeniedActions,
        });
    }
}

module.exports = {
    CapabilityPolicy,
    DEFAULT_DENIED_ACTIONS,
    bindRulesToSession,
    wildcardMatch,
};
