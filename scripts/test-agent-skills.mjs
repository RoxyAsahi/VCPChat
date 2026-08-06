import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

import { renderAgentSkillSettings } from '../modules/ui-system/agent-skill-settings-view.js';

const require = createRequire(import.meta.url);
const { RuntimeSkillService, stableSkillId } = require('../modules/codex-runtime/runtime-skill-service.js');
const { normalizeProfile, normalizeSessionConfig } = require('../modules/codex-runtime/dataContracts.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-skills-'));
const workspace = path.join(root, 'workspace');
const skillRoot = path.join(root, 'skills', 'document-review');
const skillPath = path.join(skillRoot, 'SKILL.md');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(skillRoot, { recursive: true });
fs.writeFileSync(skillPath, '---\nname: document-review\ndescription: Review documents\n---\n\n# Workflow\n', 'utf8');

const session = {
    sessionId: 'session-a', workspaceRoot: workspace,
    configSnapshot: { skillPolicy: { schemaVersion: 1, preset: 'custom', enabledSkillIds: [stableSkillId(skillPath)] } },
};
const calls = [];
const service = new RuntimeSkillService({
    repository: () => ({ getSession: (id) => id === session.sessionId ? session : null }),
    projectRoot: () => root,
    resolveAgentProfile: (id) => id === 'Nova' ? {
        id: 'Nova', workspaceRoot: workspace, skillPolicy: { preset: 'all' },
    } : null,
    start: async () => {},
    transport: () => ({
        async request(method, params) {
            calls.push({ method, params });
            return {
                data: [{
                    cwd: workspace,
                    skills: [{
                        name: 'document-review', description: 'Review documents', enabled: true,
                        path: skillPath, scope: 'user',
                        interface: { displayName: 'Document Review', shortDescription: 'Review a document' },
                    }],
                    errors: [],
                }],
            };
        },
    }),
});

const listed = await service.list({ sessionId: session.sessionId, forceReload: true });
assert.equal(calls[0].method, 'skills/list');
assert.deepEqual(calls[0].params, { cwds: [workspace], forceReload: true });
assert.equal(listed.skills[0].enabled, true);
assert.equal(listed.skills[0].name, 'document-review');
assert.equal(JSON.stringify(listed).includes(skillPath), false, 'Renderer metadata must not expose absolute Skill paths');

const detail = await service.detail({ sessionId: session.sessionId, skillId: listed.skills[0].id });
assert.match(detail.content, /# Workflow/);
assert.equal(Object.hasOwn(detail, 'path'), false);

const inputs = await service.resolveTurnInputs(session, '请用 $document-review 检查这份文件');
assert.deepEqual(inputs, [{ type: 'skill', name: 'document-review', path: skillPath }]);
assert.equal(calls.length, 1, 'a warm Skill registry must not rescan for every marker');

session.configSnapshot.skillPolicy = { schemaVersion: 1, preset: 'custom', enabledSkillIds: [] };
await assert.rejects(() => service.resolveTurnInputs(session, '$document-review run'),
    (error) => error.code === 'SKILL_DISABLED');

const profile = normalizeProfile({ name: 'Nova', skillPolicy: { preset: 'custom', enabledSkillIds: ['skill-a'] } }, 'Nova');
const config = normalizeSessionConfig({ skillPolicy: profile.skillPolicy });
assert.deepEqual(config.skillPolicy, profile.skillPolicy, 'new Session snapshots must preserve Agent Skill defaults');

const dom = new JSDOM('<!doctype html><body></body>');
const { document } = dom.window;
const node = (tag, className = '', text = '') => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
};
const toggles = [];
const view = renderAgentSkillSettings({ document, node }, {
    loading: false, catalog: listed, query: '', selectedId: listed.skills[0].id, detail,
}, session.configSnapshot.skillPolicy, {
    setQuery() {}, refresh() {}, select() {}, toggle(id, enabled) { toggles.push({ id, enabled }); },
});
assert.match(view.textContent, /Document Review/);
assert.match(view.textContent, /\$document-review/);
view.querySelector('[role="switch"]').click();
assert.deepEqual(toggles, [{ id: listed.skills[0].id, enabled: true }]);

fs.rmSync(root, { recursive: true, force: true });
console.log('Agent Skill runtime and view tests passed.');
