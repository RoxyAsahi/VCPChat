import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = '/Users/asahi/Documents/Codex/vcpchat-exp-schema';
const css = fs.readFileSync(path.join(repoRoot, 'styles/setting/settings-group-sections.css'), 'utf8');
const schema = await import(pathToFileURL(path.join(repoRoot, 'modules/settings/schema/sidebar-surfaces.js')).href);
const surfaceModule = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-surface.js')).href);

function createDocument() {
    const dom = new JSDOM('<!doctype html><html><body><main id="tabContentSettings" class="active" aria-hidden="false"><div id="agentSettingsContainer"></div><p id="selectAgentPromptForSettings">请选择</p></main></body></html>', { url: 'http://localhost' });
    return { dom, document: dom.window.document };
}

test('schema contract declares both settings domains, validation, dependency and tooltip metadata', () => {
    const { settingsSidebarSchema } = schema;
    assert.deepEqual(settingsSidebarSchema.agent.sections, ['identity', 'prompt', 'model', 'params', 'tts']);
    assert.deepEqual(settingsSidebarSchema.group.sections, ['identity', 'mode', 'model', 'prompt']);
    const temperature = settingsSidebarSchema.agent.fields.find(field => field.id === 'agentTemperature');
    assert.deepEqual(temperature.validation, { min: 0, max: 2 });
    assert.equal(typeof temperature.tooltip, 'undefined');
    const tagMode = settingsSidebarSchema.group.fields.find(field => field.id === 'tagMatchMode');
    assert.deepEqual(tagMode.dependsOn, { field: 'groupChatMode', equals: 'naturerandom' });
    assert.ok(settingsSidebarSchema.group.fields.every(field => field.tooltip || field.id === 'groupNameInput'));
});

test('schema-rendered Agent surface exposes every business anchor and all controls respond to interaction', () => {
    const { dom, document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);
    assert.equal(form.id, 'agentSettingsForm');

    const expectedIds = [
        'editingAgentId', 'agentAvatarPreview', 'agentAvatarInput', 'agentNameInput', 'disableCustomColors',
        'useThemeColorsInChat', 'agentAvatarBorderColor', 'agentAvatarBorderColorText', 'agentNameTextColor',
        'agentNameTextColorText', 'resetAvatarColorsBtn', 'agentCustomCss', 'agentCardCss', 'agentChatCss',
        'systemPromptContainer', 'agentModel', 'openModelSelectBtn', 'agentTemperature', 'agentContextTokenLimit',
        'agentMaxOutputTokens', 'agentTopP', 'agentTopK', 'agentStreamOutputTrue', 'agentStreamOutputFalse',
        'agentTtsVoicePrimary', 'refreshTtsModelsBtn', 'agentTtsRegexPrimary', 'agentTtsVoiceSecondary',
        'agentTtsRegexSecondary', 'agentTtsSpeed', 'ttsSpeedValue', 'agentTtsDirectorPromptInput',
        'fillAgentTtsDirectorTemplateBtn', 'addAgentTtsDirectorPromptBtn', 'agentTtsDirectorPromptsContainer',
        'deleteAgentBtn'
    ];
    for (const id of expectedIds) assert.ok(document.getElementById(id), `schema surface missing #${id}`);

    const sections = [...form.querySelectorAll('[data-schema-section][data-section-key]')];
    assert.deepEqual(sections.map(section => section.dataset.sectionKey), ['identity', 'prompt', 'model', 'params', 'tts']);
    assert.equal(form.querySelectorAll('.agent-settings-section-title-row').length, sections.length);
    assert.equal(form.querySelector('[data-section-key="prompt"] .agent-settings-section-title-row > .agent-settings-section-title')?.textContent, '系统提示词');
    assert.equal(form.querySelector('#refreshTtsModelsBtn .vcp-ui-icon')?.textContent, 'refresh');
    const sectionEvents = [];
    sections.forEach(section => section.querySelector('.agent-settings-section-header').addEventListener('click', () => sectionEvents.push(section.dataset.sectionKey)));
    sections.forEach(section => section.querySelector('.agent-settings-section-header').click());
    assert.deepEqual(sectionEvents, ['identity', 'prompt', 'model', 'params', 'tts']);

    const name = document.getElementById('agentNameInput');
    name.value = '测试助手';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(name.value, '测试助手');
    document.getElementById('agentTemperature').value = '1.2';
    document.getElementById('agentStreamOutputFalse').click();
    assert.equal(document.getElementById('agentStreamOutputFalse').checked, true);
    document.getElementById('fillAgentTtsDirectorTemplateBtn').click();
    assert.ok(document.getElementById('fillAgentTtsDirectorTemplateBtn').type === 'button');
    assert.equal(form.querySelectorAll('button').length >= 10, true);
});

test('schema-rendered Group surface preserves dynamic slots and dependency state', () => {
    const { dom, document } = createDocument();
    const host = document.createElement('div');
    host.id = 'groupSettingsContainer';
    document.querySelector('main').append(host);
    const form = schema.renderGroupSettingsSurface(host, document);
    assert.equal(form.id, 'groupSettingsForm');
    for (const id of ['editingGroupId', 'groupNameInput', 'groupAvatarInput', 'groupAvatarPreview', 'groupMembersList',
        'groupChatMode', 'sequentialOrderContainer', 'sequentialSpeakerOrderList', 'memberTagsContainer',
        'tagMatchMode', 'memberTagsInputs', 'groupUseUnifiedModel', 'groupUnifiedModelContainer',
        'groupUnifiedModelInput', 'openGroupModelSelectBtn', 'groupPrompt', 'invitePrompt', 'deleteGroupBtn']) {
        assert.ok(document.getElementById(id), `schema surface missing #${id}`);
    }
    const mode = document.getElementById('groupChatMode');
    const sequential = document.getElementById('sequentialOrderContainer');
    const tags = document.getElementById('memberTagsContainer');
    mode.value = 'sequential';
    assert.equal(sequential.hidden, true, 'business renderer owns initial dependency projection');
    mode.value = 'naturerandom';
    document.getElementById('groupUseUnifiedModel').click();
    assert.equal(document.getElementById('groupUseUnifiedModel').checked, true);
    assert.equal(form.querySelectorAll('button').length >= 6, true);
    assert.equal(tags.hidden, true, 'schema marks the dependent slot without stealing GroupRenderer ownership');
});

test('sidebar surface physically unmounts inactive settings and rejects stale async commits', async () => {
    const { document } = createDocument();
    const root = document.querySelector('main');
    const prompt = document.getElementById('selectAgentPromptForSettings');
    const agentHost = document.getElementById('agentSettingsContainer');
    const groupHost = document.createElement('div');
    groupHost.id = 'groupSettingsContainer';
    root.append(groupHost);
    const surface = surfaceModule.createSettingsSidebarSurface({ document, root, prompt });
    surface.register('agent', agentHost);
    surface.register('group', groupHost);
    surface.show('agent', { id: 'a' });
    assert.equal(agentHost.parentNode, root);
    const token = surface.show('agent', { id: 'a' });
    surface.setPanelActive(false);
    assert.equal(agentHost.parentNode, null);
    assert.equal(groupHost.parentNode, null);
    assert.equal(surface.isCurrent(token), false);
    surface.setPanelActive(true);
    surface.show('group', { id: 'g' });
    assert.equal(groupHost.parentNode, root);
    await surface.dispose('test');
    assert.equal(groupHost.parentNode, null);
});

test('inactive settings tab cannot create a hit area over the Agent list', () => {
    assert.match(css, /#tabContentSettings:not\(\.active\)[\s\S]*?display:\s*none\s*!important/);
    assert.match(css, /#tabContentSettings:not\(\.active\)[\s\S]*?pointer-events:\s*none\s*!important/);
    assert.match(css, /#tabContentSettings:not\(\.active\)[\s\S]*?visibility:\s*hidden\s*!important/);
});
