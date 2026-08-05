import { createAgentSessionContextMenuView } from './agent-session-context-menu-view.js';

function createAgentSessionManagementFeature({
    state,
    controller,
    document,
    window,
    node,
    visualActionButton,
    run,
    host,
    notify,
    rememberTopic,
    rememberTopicTitle,
    forgetTopic,
    refreshControlPlane,
} = {}) {
    const view = createAgentSessionContextMenuView({
        document,
        window,
        node,
        visualActionButton,
        run,
        actions: {
            canOpen: () => !state.topicManaging,
            notify,
            openLive: (topic) => controller.hydrateTopic(topic.id, null, null, topic.agentId),
            async open(topic) {
                await controller.previewTopic(topic.id, topic.agentId, topic);
                rememberTopic({ sessionId: topic.id });
            },
            async rename(topic) {
                const title = await host.feedback.edit({
                    title: '重命名 Agent 会话',
                    value: topic.title || '',
                    required: true,
                });
                if (title?.available === false) { notify(title.reason, 'error'); return; }
                if (title === null || title === undefined || title.trim() === (topic.title || '').trim()) return;
                await controller.renameSession(topic.id, title, topic.agentId);
                rememberTopicTitle(topic, title.trim());
                await refreshControlPlane();
                notify('Agent Session 已重命名。', 'success');
            },
            async exportMarkdown(topic) {
                const result = await controller.exportSession(topic.id, 'markdown');
                if (result?.exported) notify('Agent 会话已导出。', 'success');
            },
            async archive(topic) {
                const accepted = await host.feedback.confirm({
                    title: '归档 Agent 会话',
                    message: `确定归档「${topic.title || topic.id}」吗？之后可从归档会话中恢复。`,
                });
                if (accepted !== true) return;
                await controller.archiveSession(topic.id);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已归档。', 'success');
            },
            async restore(topic) {
                await controller.restoreSession(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已恢复。', 'success');
            },
            async remove(topic) {
                const accepted = await host.feedback.confirm({
                    title: '永久删除 Agent 会话',
                    message: `永久删除「${topic.title || topic.id}」及其本地投影吗？此操作不可恢复。`,
                    danger: true,
                });
                if (accepted !== true) return;
                await controller.permanentlyDeleteSession(topic.id);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已永久删除。', 'success');
            },
        },
    });

    return Object.freeze({
        appendActions: view.appendActions,
        close: view.close,
        dispose: view.dispose,
    });
}

export { createAgentSessionManagementFeature };
