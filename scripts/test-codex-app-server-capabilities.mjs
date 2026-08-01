import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    capabilityMatrix,
    failClosedServerRequestResponse,
    serverRequestPolicy,
    versionMatchesFixture,
} = require('../modules/codex-runtime/protocolCapabilities.js');

const toolbox = capabilityMatrix('toolbox-only');
assert.equal(toolbox.codexVersionLine, '0.146');
assert.equal(toolbox.serverRequests['item/tool/call'], 'supported');
assert.equal(toolbox.serverRequests['item/commandExecution/requestApproval'], 'disabled');
assert.equal(toolbox.serverRequests.applyPatchApproval, 'disabled');
assert.equal(toolbox.serverRequests['item/tool/requestUserInput'], 'supported');
assert.equal(versionMatchesFixture('0.146.0'), true);
assert.equal(versionMatchesFixture('0.147.0'), false);

assert.deepEqual(serverRequestPolicy('item/tool/call', 'toolbox-only'), { state: 'supported', kind: 'dynamic-tool' });
assert.deepEqual(serverRequestPolicy('item/tool/requestUserInput', 'toolbox-only'), { state: 'supported', kind: 'user-input' });
assert.deepEqual(serverRequestPolicy('item/permissions/requestApproval', 'toolbox-only'), { state: 'supported', kind: 'permission' });
assert.deepEqual(serverRequestPolicy('mcpServer/elicitation/request', 'toolbox-only'), { state: 'supported', kind: 'mcp-elicitation' });
assert.equal(serverRequestPolicy('item/commandExecution/requestApproval', 'toolbox-only').state, 'disabled');
assert.equal(serverRequestPolicy('item/commandExecution/requestApproval', 'codex-native').state, 'supported');
assert.equal(serverRequestPolicy('applyPatchApproval', 'toolbox-only').state, 'disabled');
assert.equal(serverRequestPolicy('applyPatchApproval', 'codex-native').kind, 'legacy-native-approval');
assert.deepEqual(failClosedServerRequestResponse('item/fileChange/requestApproval'), { decision: 'decline' });
assert.deepEqual(failClosedServerRequestResponse('execCommandApproval'), { decision: 'abort' });
assert.deepEqual(failClosedServerRequestResponse('item/tool/requestUserInput'), { answers: {} });
assert.deepEqual(failClosedServerRequestResponse('item/permissions/requestApproval'), { permissions: {}, scope: 'turn' });
assert.deepEqual(failClosedServerRequestResponse('mcpServer/elicitation/request'), { action: 'cancel', content: null, _meta: null });

const root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'codex-app-server-v0.146.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, fixture.schemaManifest), 'utf8'));
assert.equal(manifest.codexVersion, fixture.codexVersion);
assert.equal(manifest.sourceRevision, fixture.sourceRevision);
const experimental = manifest.generated.experimental.inventory;
for (const method of [...fixture.clientMethods.stable, ...fixture.clientMethods.disabledInToolboxOnly]) {
    assert.ok(experimental.clientRequests.includes(method) || experimental.clientNotifications.includes(method),
        `capability fixture must not invent client method ${method}`);
}
for (const method of Object.keys(fixture.serverRequests)) {
    assert.ok(experimental.serverRequests.includes(method), `capability fixture must not invent server request ${method}`);
}
for (const item of [...fixture.items.stable, ...fixture.items.readOnlyOrDisabledInToolboxOnly]) {
    assert.ok(experimental.threadItems.includes(item), `capability fixture must not invent ThreadItem ${item}`);
}
console.log('Codex App Server capability fixture tests passed.');
