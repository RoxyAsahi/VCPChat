import { node } from './agent-workbench-dom.js';

const ERROR_GUIDANCE = Object.freeze({
    save: {
        impact: '当前修改尚未确认写入，关闭页面可能仍保留旧值。',
        nextStep: '保留当前输入，重新读取后处理冲突或再次保存。',
    },
    apply: {
        impact: '下一个 Turn 可能仍使用旧配置，发送 barrier 也可能阻止发送。',
        nextStep: '确认当前 Turn 已结束，然后使用“重新应用”。',
    },
    runtime: {
        impact: '当前 Session 的运行状态无法确认。',
        nextStep: '先重新读取；持续失败时重新进入该 Session 并复制诊断。',
    },
    adapter: {
        impact: '最近一次模型请求未正常完成。',
        nextStep: '检查 ToolBox Endpoint、模型可用性和服务状态后重试。',
    },
    projection: {
        impact: '当前 Session 的历史或实时 Block 可能尚未完成权威对账。',
        nextStep: '重新读取 Session；持续失败时复制诊断并检查 Thread identity。',
    },
    storage: {
        impact: 'Projection 可能进入只读模式，发送和设置修改会被阻止。',
        nextStep: '先复制诊断或导出数据，再修复 Projection 数据库。',
    },
    read: {
        impact: '页面无法确认已保存配置与 Runtime 当前值。',
        nextStep: '使用“重新读取”；持续失败时复制诊断。',
    },
});

function guidanceRow(document, label, value) {
    const row = node('div', 'agent-chat-config-error-guidance', undefined, document);
    row.append(node('strong', '', label, document), node('span', '', value, document));
    return row;
}

function errorCard(document, label, error, kind) {
    if (!error) return null;
    const guidance = ERROR_GUIDANCE[kind] || {
        impact: '影响范围尚未确认。',
        nextStep: '重新读取状态；持续失败时复制脱敏诊断。',
    };
    const card = node('section', 'agent-chat-config-diagnostic-error', undefined, document);
    const header = node('div', 'agent-chat-config-error-header', undefined, document);
    const code = node('code', '', error.code || 'UNKNOWN_ERROR', document);
    code.title = code.textContent;
    header.append(
        node('strong', '', label, document),
        code,
    );
    card.append(
        header,
        node('p', 'agent-chat-config-error-message', error.message, document),
        guidanceRow(document, '影响', guidance.impact),
        guidanceRow(document, '下一步', guidance.nextStep),
    );
    if (error.details) {
        const details = node('details', 'agent-chat-config-error-details', undefined, document);
        details.append(
            node('summary', '', '脱敏技术详情', document),
            node('pre', '', JSON.stringify(error.details, null, 2), document),
        );
        card.append(details);
    }
    return card;
}

function createDiagnosticErrorsView(document, model = {}, request = {}) {
    const errors = node('div', 'agent-chat-config-diagnostic-errors', undefined, document);
    const cards = [
        errorCard(document, '保存错误', model.saveError, 'save'),
        errorCard(document, '配置应用错误', model.applyError, 'apply'),
        errorCard(document, 'Runtime 错误', model.runtimeError, 'runtime'),
        errorCard(document, 'Adapter 错误', model.adapterError, 'adapter'),
        errorCard(document, 'Projection 对账错误', model.projectionError, 'projection'),
        errorCard(document, 'Projection 存储错误', model.storageError, 'storage'),
        errorCard(document, '读取诊断失败', request.error, 'read'),
    ];
    for (const card of cards.filter(Boolean)) errors.append(card);
    return errors;
}

export { createDiagnosticErrorsView };
