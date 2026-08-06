import { createAgentProfileFlowView } from './agent-profile-flow-view.js';

function createAgentProfileFlowFeature({
    state,
    controller,
    element,
    document,
    run,
    queueRender,
    refreshControlPlane,
    notify,
} = {}) {
    function close() {
        state.topicFlow = null;
        queueRender({ topicFlow: true });
    }

    const view = createAgentProfileFlowView({
        element,
        document,
        actions: {
            close,
            updateDraft(patch) {
                if (state.topicFlow?.kind === 'agent') Object.assign(state.topicFlow, patch);
            },
            selectWorkspace(currentPath) {
                return controller.workspaceSelectRoot({ currentPath });
            },
            reportError(error) {
                notify(error?.message || '工作目录选择失败。', 'error');
            },
            submit(request) {
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'agent' || state.topicFlow.saving) return;
                    state.topicFlow = { ...state.topicFlow, saving: true };
                    queueRender({ topicFlow: true });
                    try {
                        const result = await controller.saveAgentProfile(request);
                        if (!result?.success || !result.profile?.id) {
                            throw new Error(result?.error || 'Build Agent 创建失败。');
                        }
                        controller.clearSelection?.();
                        state.selectedAgent = result.profile.id;
                        state.topicFlow = null;
                        await refreshControlPlane();
                        state.tab = 'sessions';
                        notify(`已创建 Build Agent「${result.profile.name || result.profile.id}」。`, 'success');
                    } finally {
                        if (state.topicFlow?.kind === 'agent') {
                            state.topicFlow = { ...state.topicFlow, saving: false };
                        }
                        queueRender({ shell: true, header: true, composer: true, topicFlow: true });
                    }
                });
            },
        },
    });

    return Object.freeze({
        view,
        open() {
            state.topicFlow = {
                kind: 'agent',
                name: '',
                systemPrompt: '',
                model: state.model || '',
                workspaceRoot: '',
                permissionMode: 'ask',
                saving: false,
            };
            queueRender({ topicFlow: true });
        },
        close,
        render() {
            view.update(state.topicFlow?.kind === 'agent'
                ? { ...state.topicFlow, modelCatalog: state.modelCatalog } : null);
        },
        dispose() {
            view.dispose();
        },
    });
}

export { createAgentProfileFlowFeature };
