function formatRunElapsed(milliseconds) {
    const seconds = Math.max(0, milliseconds) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const wholeSeconds = Math.floor(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const remainder = wholeSeconds % 60;
    if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function createAgentWorkbenchRunStatusView({ refs, lifecycle, now = () => Date.now() }) {
    const { runStatus, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop } = refs;
    let model = null;

    function renderElapsed() {
        if (!model?.visible) return;
        const elapsedMs = now() - model.startedAt;
        runStatusElapsed.textContent = formatRunElapsed(elapsedMs);
        runStatusElapsed.dateTime = `PT${Math.max(0, elapsedMs / 1000).toFixed(1)}S`;
    }

    function update(nextModel = {}) {
        model = {
            visible: Boolean(nextModel.visible),
            state: nextModel.state || 'idle',
            label: nextModel.label || '正在运行',
            detail: nextModel.detail || 'Agent 正在处理当前任务',
            startedAt: Number(nextModel.startedAt) || now(),
            canStop: Boolean(nextModel.canStop),
        };
        runStatus.hidden = !model.visible;
        if (!model.visible) {
            lifecycle.clear('run-status');
            return;
        }
        runStatus.dataset.state = model.state;
        runStatusLabel.textContent = model.label;
        runStatusDetail.textContent = model.detail;
        runStatusStop.hidden = !model.canStop;
        runStatusStop.disabled = !model.canStop;
        renderElapsed();
        lifecycle.interval('run-status', renderElapsed, 250);
    }

    return {
        element: runStatus,
        update,
        dispose() {
            model = null;
            lifecycle.clear('run-status');
        },
    };
}

export { createAgentWorkbenchRunStatusView, formatRunElapsed };
