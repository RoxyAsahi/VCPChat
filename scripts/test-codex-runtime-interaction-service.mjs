import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeInteractionService } = require('../modules/codex-runtime/runtime-interaction-service.js');

const responses = [];
const responseErrors = [];
const events = [];
const toolboxResponses = [];
let generation = 7;
const session = { sessionId: 'session-a', configSnapshot: { executionProfile: 'codex-native' } };
const transport = {
    respond: (requestId, response) => responses.push({ requestId, response }),
    respondError: (requestId, code, message) => responseErrors.push({ requestId, code, message }),
};
const bridge = {
    async respondApproval(payload) { toolboxResponses.push(payload); return { written: true }; },
};
const service = new RuntimeInteractionService({
    repository: () => ({ getSessionByThread: (threadId) => threadId === 'thread-a' ? session : null }),
    transport: () => transport,
    bridge: () => bridge,
    runtimeGeneration: () => generation,
    workbenchMounted: () => true,
    profileForRequest: () => 'codex-native',
    sendUiEvent: (event) => events.push(event),
    diagnostic: () => {},
});
service.interactions.setGeneration('codex-native', generation);
service.interactions.setGeneration('toolbox', 3);

service.acceptServerRequest({
    id: 'approval-1', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', command: 'test' },
});
assert.equal(service.serverRequests.size, 1);
assert.equal(events.at(-1).type, 'approval.requested');
await assert.rejects(
    service.respondApproval({ requestId: 'approval-1', decision: 'accept', generation: generation - 1 }),
    (error) => error.code === 'STALE_INTERACTION_GENERATION',
);
await service.respondApproval({ requestId: 'approval-1', decision: 'accept', generation });
assert.deepEqual(responses.at(-1), { requestId: 'approval-1', response: { decision: 'accept' } });
assert.equal(service.serverRequests.size, 0);
await assert.rejects(
    service.respondApproval({ requestId: 'approval-1', decision: 'accept', generation }),
    (error) => error.code === 'NOT_FOUND',
);

service.acceptServerRequest({
    id: 'input-1', method: 'item/tool/requestUserInput',
    params: { threadId: 'thread-a', turnId: 'turn-a', questions: [{ id: 'answer', prompt: 'Answer?' }] },
});
await service.respondInteraction({
    requestId: 'input-1', kind: 'user-input', generation,
    response: { answers: { answer: ['yes'] } },
});
assert.deepEqual(responses.at(-1).response, { answers: { answer: { answers: ['yes'] } } });

const toolboxApproval = {
    requestId: 'toolbox-1', generation: 3, expiresAtMs: Date.now() + 60_000,
};
service.toolboxApprovals.set(toolboxApproval.requestId, toolboxApproval);
service.interactions.enqueue({ source: 'toolbox', requestId: toolboxApproval.requestId, generation: 3, kind: 'approval' });
await service.respondApproval({ requestId: toolboxApproval.requestId, scope: 'toolbox', decision: 'accept', generation: 3 });
assert.deepEqual(toolboxResponses.at(-1), { requestId: 'toolbox-1', approved: true, reason: undefined });

service.acceptServerRequest({ id: 'unsupported-1', method: 'unknown/request', params: { threadId: 'thread-a' } });
assert.equal(responseErrors.at(-1).requestId, 'unsupported-1');
assert.equal(events.at(-1).type, 'interaction.rejected');

service.acceptServerRequest({
    id: 'approval-2', method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-a', turnId: 'turn-b', itemId: 'item-b' },
});
await service.failClosedNativeApprovals('test shutdown');
assert.equal(service.serverRequests.size, 0);
assert.equal(events.at(-1).payload.decision, 'decline');
service.clearTimers();

let releaseInFlight;
const inFlightWrites = [];
const raceService = new RuntimeInteractionService({
    repository: () => ({ getSessionByThread: () => session }),
    transport: () => transport,
    bridge: () => ({
        respondApproval(payload) {
            inFlightWrites.push(payload);
            return new Promise((resolve) => { releaseInFlight = () => resolve({ written: true }); });
        },
    }),
    runtimeGeneration: () => generation,
    workbenchMounted: () => true,
    profileForRequest: () => 'codex-native',
    sendUiEvent: () => {},
    diagnostic: () => {},
});
raceService.interactions.setGeneration('toolbox', 4);
const racingApproval = { requestId: 'toolbox-race', generation: 4, expiresAtMs: Date.now() + 60_000 };
raceService.toolboxApprovals.set(racingApproval.requestId, racingApproval);
raceService.interactions.enqueue({ source: 'toolbox', requestId: racingApproval.requestId, generation: 4, kind: 'approval' });
const accepting = raceService.respondApproval({
    requestId: racingApproval.requestId, scope: 'toolbox', decision: 'accept', generation: 4,
});
await Promise.resolve();
const stopping = raceService.failClosedToolboxApprovals('runtime stopped');
releaseInFlight();
await Promise.all([accepting, stopping]);
assert.equal(inFlightWrites.length, 1, 'fail-closed must not write a second decision while approval response is in flight');
assert.equal(inFlightWrites[0].approved, true);
assert.equal(raceService.toolboxApprovals.size, 0);

console.log('Codex Runtime interaction service tests passed.');
