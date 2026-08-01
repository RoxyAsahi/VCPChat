import { createApprovalCard } from './approval.js';
import { createErrorCard, createUnknownBlockCard } from './error.js';
import { createMarkerObservationCard, createToolboxObservationCard } from './observation.js';
import { createToolBlockRenderer } from './tool.js';

function createAgentBlockPresentation(options = {}) {
    const document = options.document || globalThis.document;
    if (!document) throw new TypeError('Agent block presentation requires document');
    const actions = options.actions || {};
    const tool = createToolBlockRenderer({
        document,
        renderContent: options.renderContent,
        postRender: options.postRender,
        onCancel: actions.cancelTool,
    });

    return {
        timelineCallbacks: {
            create(part) {
                if (part.kind === 'tool') return tool.create(part.value);
                if (part.kind === 'error') return createErrorCard(document, part.value || part);
                return createUnknownBlockCard(document, part);
            },
            patch(row, part) {
                if (part.kind === 'tool') return tool.patch(row, part.value);
                const replacement = part.kind === 'error'
                    ? createErrorCard(document, part.value || part)
                    : createUnknownBlockCard(document, part);
                row.replaceWith(replacement);
                return replacement;
            },
        },
        createApproval(approval, approvalOptions = {}) {
            return createApprovalCard(document, approval, {
                ...approvalOptions,
                onDecision: approvalOptions.onDecision || actions.respondApproval,
            });
        },
        createToolboxObservation(observation) {
            return createToolboxObservationCard(document, observation, actions.respondToolboxApproval);
        },
        createMarkerObservation(observation) {
            return createMarkerObservationCard(document, observation);
        },
        createError(error) {
            return createErrorCard(document, error);
        },
    };
}

export { createAgentBlockPresentation };
