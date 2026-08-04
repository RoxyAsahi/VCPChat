'use strict';

const {
    bridgeResultContentItems,
    classifyToolboxEvent,
    decodeVcpInvokeCall,
    sanitizeToolboxValue,
} = require('./runtime-normalizers');

class RuntimeToolboxService {
    constructor(context) {
        this.context = Object.freeze(context);
        this.dynamicCalls = new Map();
    }

    async handleDynamicToolCall(message) {
        const params = message.params || {};
        const transport = this.context.transport();
        const operation = this.context.createOperationContext({
            threadId: params.threadId,
            turnId: params.turnId,
        });
        const respond = (result) => {
            try {
                this.context.assertOperationContext(operation);
            } catch {
                return false;
            }
            if (this.context.transport() !== transport) return false;
            transport?.respond(message.id, result);
            return true;
        };
        const bridge = this.context.bridge();
        if (!bridge) {
            try {
                this.context.assertOperationContext(operation);
            } catch {
                return;
            }
            if (this.context.transport() === transport) {
                transport?.respondError(message.id, -32001, 'vcp-toolbox-bridge is not connected');
            }
            this.context.interactions.serverRequests.delete(String(message.id));
            return;
        }
        let invocation;
        try {
            invocation = decodeVcpInvokeCall(params);
        } catch (error) {
            respond({
                contentItems: [{ type: 'inputText', text: `Invalid vcp_invoke request: ${error.message}` }],
                success: false,
            });
            return;
        }
        const requestId = String(message.id);
        const bridgeRequestId = `codex:${params.threadId}:${params.turnId}:${params.callId}`;
        this.context.interactions.serverRequests.set(requestId, message);
        this.dynamicCalls.set(requestId, {
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
            bridgeRequestId,
            wrapperToolName: invocation.wrapperToolName,
            targetToolName: invocation.targetToolName,
            operation,
            bridge,
            transport,
        });
        try {
            const result = await bridge.invoke({
                requestId: bridgeRequestId,
                toolName: invocation.targetToolName,
                arguments: invocation.targetArguments,
            });
            this.context.assertOperationContext(operation);
            const toolboxResult = result.result || result;
            respond({
                contentItems: bridgeResultContentItems(toolboxResult),
                success: toolboxResult.ok !== false && !toolboxResult.error,
            });
        } catch (error) {
            try {
                this.context.assertOperationContext(operation);
            } catch {
                return;
            }
            respond({
                contentItems: [{ type: 'inputText', text: `VCPToolBox bridge failed: ${error.message}` }],
                success: false,
            });
        } finally {
            if (this.context.interactions.serverRequests.get(requestId) === message) {
                this.context.interactions.serverRequests.delete(requestId);
            }
            if (this.dynamicCalls.get(requestId)?.operation === operation) {
                this.dynamicCalls.delete(requestId);
            }
        }
    }

    async interruptDynamicCalls(reason) {
        const calls = [...this.dynamicCalls.values()];
        this.dynamicCalls.clear();
        for (const [requestId, request] of [...this.context.interactions.serverRequests.entries()]) {
            if (request.method === 'item/tool/call') this.context.interactions.serverRequests.delete(requestId);
        }
        await Promise.all(calls.map(async (call) => {
            try {
                await call.bridge?.interrupt(call.bridgeRequestId);
            } catch (error) {
                this.context.diagnostic(`Could not interrupt ToolBox dynamic call ${call.bridgeRequestId}: ${error.message}`);
            }
        }));
        if (calls.length) {
            this.context.sendUiEvent({
                type: 'runtime.warning',
                payload: { warning: `${calls.length} VCP dynamic call(s) were interrupted: ${reason}` },
            });
        }
    }

    handleBridgeEvent(message) {
        const channel = message?.channel;
        const value = message?.event;
        if (channel === 'backend-approval') {
            const requestId = String(value?.requestId || '').trim();
            const expiresAtMs = Number(value?.expiresAtMs) || 0;
            if (!requestId || expiresAtMs <= Date.now()) return;
            const generation = this.context.toolboxAuthorityGeneration();
            const approval = {
                approvalId: requestId,
                requestId,
                scope: 'toolbox',
                expiresAtMs,
                replay: value?.replay === true,
                toolName: value?.data?.toolName || null,
                reason: value?.data?.reason || null,
                generation,
            };
            const queued = this.context.interactions.interactions.enqueue({
                source: 'toolbox', requestId, kind: 'backend-approval', expiresAtMs, generation,
            });
            if (!queued.accepted) return;
            this.context.interactions.toolboxApprovals.set(requestId, approval);
            this.context.sendUiEvent({ type: 'approval.requested', payload: { approval } });
            return;
        }
        this.context.sendUiEvent({
            type: 'toolbox.ws',
            payload: {
                channel: channel || 'toolbox',
                kind: classifyToolboxEvent(channel, value),
                value: sanitizeToolboxValue(value),
            },
        });
    }
}

module.exports = { RuntimeToolboxService };
