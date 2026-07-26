'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stableStringify } = require('../contracts');

const MANIFEST_ENABLED = 'plugin-manifest.json';
const MANIFEST_BLOCKED = 'plugin-manifest.json.block';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MUTATING_PATTERN = /write|append|edit|apply|create|delete|remove|move|rename|copy|upload|download|install|uninstall|execute|exec|shell|terminal|powershell|bash|kill|shutdown/i;
const SHELL_PATTERN = /shell|terminal|powershell|bash|cmd|exec(ute)?/i;
const NETWORK_PATTERN = /web|http|fetch|download|upload|network|remote|browser/i;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeName(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function normalizeRoots(roots) {
    if (!Array.isArray(roots)) {
        throw new TypeError('LocalToolCatalog roots must be an array');
    }
    return roots.map((entry, index) => {
        const value = typeof entry === 'string' ? { path: entry } : entry;
        if (!value || typeof value.path !== 'string' || value.path.trim() === '') {
            throw new TypeError(`Invalid ToolBox root at index ${index}`);
        }
        const rootPath = path.resolve(value.path);
        const pluginRoot = path.basename(rootPath).toLowerCase() === 'plugin'
            ? rootPath
            : path.join(rootPath, 'Plugin');
        return Object.freeze({
            id: safeName(value.id, `toolbox-${index + 1}`),
            rootPath,
            pluginRoot,
        });
    });
}

function walkPluginDirectories(pluginRoot) {
    const directories = [];
    const pending = [pluginRoot];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        directories.push({ current, entries });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                pending.push(path.join(current, entry.name));
            }
        }
    }
    return directories;
}

function commandEntries(manifest) {
    const source = manifest && manifest.capabilities && manifest.capabilities.invocationCommands;
    if (Array.isArray(source)) {
        return source.map((command, index) => [
            safeName(command && (command.commandIdentifier || command.command || command.name), `command-${index + 1}`),
            command || {},
        ]);
    }
    if (source && typeof source === 'object') {
        return Object.entries(source).map(([name, command]) => [name, command && typeof command === 'object' ? command : {}]);
    }
    return [];
}

function normalizeSchema(command) {
    const candidate = command.inputSchema || command.parameters || command.schema;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { status: 'unknown', value: null };
    }
    return { status: 'declared', value: clone(candidate) };
}

function classifyRisk(pluginName, commandName, command) {
    const declared = command.risk || command.riskLevel || command.riskClass;
    if (typeof declared === 'string' && declared.trim()) {
        return { level: declared.trim().toLowerCase(), source: 'manifest' };
    }
    const text = `${pluginName} ${commandName}`;
    if (SHELL_PATTERN.test(text)) {
        return { level: 'critical', source: 'heuristic' };
    }
    if (MUTATING_PATTERN.test(text)) {
        return { level: 'high', source: 'heuristic' };
    }
    if (NETWORK_PATTERN.test(text)) {
        return { level: 'medium', source: 'heuristic' };
    }
    return { level: 'unknown', source: 'legacy-unknown' };
}

function normalizeReliability(manifest, command) {
    const value = command.reliability || (manifest.capabilities && manifest.capabilities.reliability) || manifest.reliability;
    if (typeof value === 'string' && value.trim()) {
        return { level: value.trim().toLowerCase(), source: 'manifest' };
    }
    return { level: 'unknown', source: 'legacy-unknown' };
}

function publicDescription(command) {
    const value = typeof command.description === 'string' ? command.description.trim() : '';
    return value.slice(0, 4096);
}

function toolFingerprint(tool) {
    return sha256(stableStringify(tool));
}

function diffTools(previous, current) {
    const before = new Map((previous && previous.tools || []).map((tool) => [tool.id, tool]));
    const after = new Map(current.tools.map((tool) => [tool.id, tool]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [id, tool] of after) {
        if (!before.has(id)) {
            added.push(id);
        } else if (toolFingerprint(before.get(id)) !== toolFingerprint(tool)) {
            changed.push(id);
        }
    }
    for (const id of before.keys()) {
        if (!after.has(id)) {
            removed.push(id);
        }
    }
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), hasDrift: added.length + removed.length + changed.length > 0 };
}

class LocalToolCatalog {
    constructor(options = {}) {
        this.roots = normalizeRoots(options.roots || []);
        this.cacheAdapter = options.cacheAdapter || null;
        this.clock = options.clock || (() => new Date());
        this.snapshot = null;
    }

    async loadCache() {
        if (!this.cacheAdapter || typeof this.cacheAdapter.load !== 'function') {
            return null;
        }
        const cached = await this.cacheAdapter.load();
        if (cached && cached.schemaVersion === 1 && Array.isArray(cached.tools)) {
            this.snapshot = clone(cached);
        }
        return this.getSnapshot();
    }

    async refresh() {
        const previous = this.snapshot;
        const tools = [];
        const diagnostics = [];
        const ids = new Set();
        if (this.roots.length === 0) {
            const next = {
                schemaVersion: 1,
                status: 'unavailable',
                available: false,
                generatedAt: this.clock().toISOString(),
                tools,
                diagnostics: [{ code: 'TOOLBOX_ROOT_UNAVAILABLE', message: 'No local ToolBox root is configured' }],
            };
            next.catalogHash = sha256(stableStringify({ schemaVersion: next.schemaVersion, tools, diagnostics: next.diagnostics }));
            next.drift = diffTools(previous, next);
            this.snapshot = clone(next);
            if (this.cacheAdapter && typeof this.cacheAdapter.save === 'function') await this.cacheAdapter.save(this.getSnapshot());
            return this.getSnapshot();
        }
        for (const root of this.roots) {
            for (const { current, entries } of walkPluginDirectories(root.pluginRoot)) {
                const enabledEntry = entries.find((entry) => entry.isFile() && entry.name === MANIFEST_ENABLED);
                const blockedEntry = entries.find((entry) => entry.isFile() && entry.name === MANIFEST_BLOCKED);
                if (!enabledEntry && !blockedEntry) {
                    continue;
                }
                if (enabledEntry && blockedEntry) {
                    diagnostics.push({ code: 'MANIFEST_SHADOWED_BLOCK', rootId: root.id, pluginPath: path.relative(root.pluginRoot, current) });
                }
                const manifestName = enabledEntry ? MANIFEST_ENABLED : MANIFEST_BLOCKED;
                const manifestPath = path.join(current, manifestName);
                try {
                    const stat = fs.statSync(manifestPath);
                    if (stat.size > MAX_MANIFEST_BYTES) {
                        throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
                    }
                    const raw = fs.readFileSync(manifestPath);
                    const manifest = JSON.parse(raw.toString('utf8'));
                    const fallbackName = path.basename(current);
                    const pluginName = safeName(manifest.name, fallbackName);
                    for (const [commandName, command] of commandEntries(manifest)) {
                        const id = `${pluginName}:${commandName}`;
                        if (ids.has(id)) {
                            diagnostics.push({ code: 'DUPLICATE_TOOL_ID', id, manifestHash: sha256(raw) });
                            continue;
                        }
                        ids.add(id);
                        tools.push(Object.freeze({
                            id,
                            source: Object.freeze({
                                kind: 'local-toolbox-manifest',
                                rootId: root.id,
                                plugin: pluginName,
                                relativeManifestPath: path.relative(root.pluginRoot, manifestPath).replaceAll('\\', '/'),
                            }),
                            display: Object.freeze({
                                pluginName: safeName(manifest.displayName, pluginName),
                                commandName,
                                description: publicDescription(command),
                            }),
                            enabled: manifestName === MANIFEST_ENABLED,
                            schema: normalizeSchema(command),
                            reliability: normalizeReliability(manifest, command),
                            risk: classifyRisk(pluginName, commandName, command),
                            manifestHash: sha256(raw),
                        }));
                    }
                } catch (error) {
                    diagnostics.push({
                        code: 'MANIFEST_INVALID',
                        rootId: root.id,
                        relativeManifestPath: path.relative(root.pluginRoot, manifestPath).replaceAll('\\', '/'),
                        message: error.message,
                    });
                }
            }
        }
        tools.sort((a, b) => a.id.localeCompare(b.id));
        const rootAvailable = this.roots.some((root) => fs.existsSync(root.pluginRoot));
        if (!rootAvailable) diagnostics.push({ code: 'TOOLBOX_ROOT_UNAVAILABLE', message: 'Configured ToolBox plugin roots are unavailable' });
        const base = {
            schemaVersion: 1,
            status: rootAvailable ? 'ready' : 'unavailable',
            available: rootAvailable,
            generatedAt: this.clock().toISOString(),
            tools,
            diagnostics,
        };
        const catalogHash = sha256(stableStringify({ schemaVersion: base.schemaVersion, tools, diagnostics }));
        const next = { ...base, catalogHash };
        next.drift = diffTools(previous, next);
        this.snapshot = clone(next);
        if (this.cacheAdapter && typeof this.cacheAdapter.save === 'function') {
            await this.cacheAdapter.save(this.getSnapshot());
        }
        return this.getSnapshot();
    }

    getSnapshot() {
        return clone(this.snapshot);
    }

    getTool(id) {
        const tool = this.snapshot && this.snapshot.tools.find((entry) => entry.id === id);
        return clone(tool || null);
    }

    get(id) {
        return this.getTool(id);
    }

    describeLegacyUnknown(toolName, action) {
        return {
            id: `${safeName(toolName, 'unknown')}:${safeName(action, 'unknown')}`,
            source: { kind: 'vcp-legacy-unknown' },
            display: { pluginName: safeName(toolName, 'Unknown legacy tool'), commandName: safeName(action, 'unknown'), description: '' },
            enabled: null,
            schema: { status: 'unknown', value: null },
            reliability: { level: 'unknown', source: 'legacy-unknown' },
            risk: { level: 'unknown', source: 'legacy-unknown' },
            manifestHash: null,
        };
    }
}

module.exports = {
    LocalToolCatalog,
    MANIFEST_ENABLED,
    MANIFEST_BLOCKED,
    diffTools,
    classifyRisk,
};
