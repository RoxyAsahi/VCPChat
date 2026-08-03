import { createWorkspaceTreeModel } from './agent-workspace-model.js';

function createWorkspaceViewState() {
    return {
        scope: '', sessionId: '', workspaceRevision: '', model: createWorkspaceTreeModel(),
        inflight: new Map(), inflightRequestIds: new Map(), previewRequestId: '', searchRequestId: '',
        error: '', preview: null, previewLoading: false, search: '', searchResults: [],
        searchLoading: false, selectedPath: '', splitPercent: 46,
    };
}

export { createWorkspaceViewState };
