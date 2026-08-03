import { node } from './agent-workbench-dom.js';

export function createAgentNotificationView({ document, blockPresentation, actions }) {
    let search = '';
    let sourceFilter = 'all';
    let kindFilter = 'all';

    function build(current, previous = {}) {
        const ws = current.toolboxWs || [];
        const markers = current.markerObservations || [];
        const existingCards = previous.cards || new Map();
        const openKeys = previous.openKeys || new Set();
        const content = node('div', 'agent-chat-notification-view');
        content.append(node('div', 'agent-chat-activity-note', '全局 VCPLog/VCPInfo 仅保留本次运行；会话关联的工具、推理和检查结果会随会话恢复。'));
        const controls = node('div', 'agent-chat-activity-filters');
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = '搜索活动';
        searchInput.value = search;
        searchInput.setAttribute('aria-label', '搜索工具活动');
        searchInput.addEventListener('input', () => {
            search = searchInput.value;
            actions.refresh();
        });
        const source = document.createElement('select');
        source.setAttribute('aria-label', '活动来源');
        for (const value of ['all', ...new Set(ws.map((item) => item.channel).filter(Boolean))]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'all' ? '全部来源' : value;
            source.append(option);
        }
        source.value = sourceFilter;
        source.addEventListener('change', () => {
            sourceFilter = source.value;
            actions.refresh();
        });
        const kind = document.createElement('select');
        kind.setAttribute('aria-label', '活动类型');
        for (const value of ['all', ...new Set([...ws.map((item) => item.kind), ...markers.map((item) => item.kind)].filter(Boolean))]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'all' ? '全部类型' : value;
            kind.append(option);
        }
        kind.value = kindFilter;
        kind.addEventListener('change', () => {
            kindFilter = kind.value;
            actions.refresh();
        });
        controls.append(searchInput, source, kind);
        content.append(controls);

        const query = search.trim().toLocaleLowerCase();
        const visibleWs = ws.filter((item) => (sourceFilter === 'all' || item.channel === sourceFilter)
            && (kindFilter === 'all' || item.kind === kindFilter)
            && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
        const visibleMarkers = markers.filter((item) => sourceFilter === 'all'
            && (kindFilter === 'all' || item.kind === kindFilter)
            && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
        const list = node('div', 'agent-chat-activity-list');
        if (!visibleWs.length && !visibleMarkers.length) {
            list.append(node('div', 'agent-chat-activity-empty', '暂无 VCPToolBox 或 VCP 内容观察事件。'));
        } else {
            for (const observation of visibleWs) {
                const card = existingCards.get(observation.id) || blockPresentation.createToolboxObservation(observation);
                card.dataset.activityKey = observation.id;
                list.append(card);
            }
            for (const observation of visibleMarkers) {
                const card = existingCards.get(observation.id) || blockPresentation.createMarkerObservation(observation);
                card.dataset.activityKey = observation.id;
                list.append(card);
            }
        }
        content.append(list);
        for (const details of content.querySelectorAll('details[data-activity-key]')) {
            if (openKeys.has(details.dataset.activityKey)) details.open = true;
        }
        return { content, searchInput, list };
    }

    return { build, dispose() {} };
}
