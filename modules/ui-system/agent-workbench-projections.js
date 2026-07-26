function projectSession(summary = {}) {
    return {
        sessionId: summary.sessionId,
        title: summary.title || summary.metadata?.title || '新 Agent 会话',
        model: summary.model || summary.metadata?.model || '未选择模型',
        workspaceRoot: summary.workspaceRoot || '',
        state: summary.state || 'unknown',
        updatedAt: summary.updatedAt || summary.createdAt || 0,
        activeTurnId: summary.activeTurnId || null,
        parentSessionId: summary.parentSessionId || summary.metadata?.forkedFrom || null,
    };
}

function normalizeContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => typeof part === 'string' ? part : part?.text || JSON.stringify(part)).join('\n');
    }
    if (content === null || content === undefined) return '';
    return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
}

function projectMessage(message = {}) {
    return {
        id: message.id || message.messageId,
        turnId: message.turnId || null,
        role: message.role || 'assistant',
        content: normalizeContent(message.content),
        reasoning: normalizeContent(message.reasoning),
        state: message.state || 'complete',
        createdAt: message.createdAt || 0,
    };
}

function projectTool(tool = {}) {
    return {
        toolCallId: tool.toolCallId,
        turnId: tool.turnId || null,
        name: tool.name || tool.payload?.toolName || 'tool',
        state: tool.state || 'requested',
        riskLevel: tool.payload?.riskLevel || 'unknown',
        summary: tool.payload?.argumentSummary
            || tool.payload?.outputSummary
            || tool.payload?.progress
            || tool.payload?.note
            || tool.payload?.reason
            || tool.payload?.error
            || '',
        eventCount: tool.events?.length || 0,
    };
}

function projectArtifact(artifact = {}) {
    return {
        artifactId: artifact.artifactId || artifact.id,
        kind: artifact.kind || artifact.type || 'artifact',
        label: artifact.title || artifact.name || artifact.path || artifact.uri || artifact.artifactId || 'Artifact',
        path: artifact.path || artifact.uri || '',
        metadata: artifact.metadata || {},
        createdAt: artifact.createdAt || 0,
    };
}

function projectPlan(plan) {
    if (!plan) return { title: 'Plan', steps: [], raw: '' };
    const value = plan.plan || plan;
    const steps = Array.isArray(value)
        ? value
        : value.steps || value.items || value.todos || [];
    return {
        title: value.title || 'Plan',
        steps: steps.map((step, index) => typeof step === 'string'
            ? { id: index, text: step, status: 'pending' }
            : {
                id: step.id || index,
                text: step.text || step.content || step.title || JSON.stringify(step),
                status: step.status || step.state || 'pending',
            }),
        raw: typeof value === 'string' ? value : '',
    };
}

export {
    projectArtifact,
    projectMessage,
    projectPlan,
    projectSession,
    projectTool,
};
