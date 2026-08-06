import { createAgentWorkspaceView } from './agent-workspace-view.js';

export function createAgentWorkspaceFeatureView({
    document, run, state, render, loadDirectory, openPreview, openFileTab,
    performPathAction, saveText, search, onBinaryPreview,
}) {
    return createAgentWorkspaceView({
        document,
        actions: {
            run,
            refresh: render,
            loadDirectory,
            openPreview,
            openFileTab,
            performPathAction,
            saveText,
            search,
            setPreviewMode(mode) {
                state.workspaceBrowser.previewMode = mode;
                state.workspaceBrowser.editError = '';
                render();
            },
            updateEditDraft(value) {
                state.workspaceBrowser.editDraft = String(value ?? '');
                state.workspaceBrowser.editDirty = state.workspaceBrowser.editDraft
                    !== String(state.workspaceBrowser.preview?.content || '');
                return state.workspaceBrowser.editDirty;
            },
            onBinaryPreview,
        },
    });
}
