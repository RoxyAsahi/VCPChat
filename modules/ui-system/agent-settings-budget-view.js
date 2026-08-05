import { node } from './agent-workbench-dom.js';

const BUDGET_FIELDS = Object.freeze([
    ['模型请求数', 'maxRequestsPerTurn'],
    ['累计 token', 'maxTokensPerTurn'],
]);

function createAgentSettingsBudgetView({ document = globalThis.document, actions = {} } = {}) {
    const element = node('section', 'agent-chat-settings-budget', undefined, document);
    let currentBudget = {};

    function update(budget = {}) {
        currentBudget = { ...budget };
        const header = node('div', 'agent-chat-settings-section-heading', undefined, document);
        header.append(
            node('strong', 'agent-chat-setting-label', '每轮预算', document),
            node('span', 'agent-chat-setting-help', '限制模型请求次数和累计 token；留空表示不限。', document),
        );
        const fields = node('div', 'agent-chat-settings-budget-fields', undefined, document);
        for (const [label, name] of BUDGET_FIELDS) {
            const wrap = node('label', 'agent-chat-setting-field', undefined, document);
            wrap.append(node('span', 'agent-chat-setting-label', label, document));
            const input = document.createElement('input');
            input.className = 'agent-chat-setting-input';
            input.type = 'number';
            input.name = name;
            input.min = '1';
            input.step = '1';
            input.placeholder = '不限';
            input.value = budget?.[name] == null ? '' : String(budget[name]);
            input.addEventListener('input', () => {
                currentBudget = { ...currentBudget, [name]: String(input.value || '').trim() || null };
                actions.save?.({ ...currentBudget });
            });
            wrap.append(input);
            fields.append(wrap);
        }
        element.replaceChildren(header, fields);
        return element;
    }

    return { element, update, dispose() { element.replaceChildren(); } };
}

export { createAgentSettingsBudgetView };
