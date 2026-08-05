'use strict';

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function turnKey(entry) {
    return String(entry?.turnId ?? entry?.codex_turn_id ?? '');
}

function sourceOrder(entry) {
    return number(entry?.sourceOrder ?? entry?.source_order);
}

function role(entry) {
    return String(entry?.role || 'assistant');
}

function isUser(entry) {
    return role(entry) === 'user';
}

function isLocalTool(entry) {
    if (entry?.isLocalTool === true || entry?.is_local_tool === 1) return true;
    return Array.isArray(entry?.blocks) && entry.blocks.some((block) => (
        block?.kind === 'tool' && block?.authority && block.authority !== 'codex'
    ));
}

function groupConsecutiveTools(entries) {
    const groups = [];
    for (const entry of entries) {
        const previous = groups.at(-1)?.at(-1);
        if (!previous || sourceOrder(entry) > sourceOrder(previous) + 1) groups.push([entry]);
        else groups.at(-1).push(entry);
    }
    return groups;
}

function distributeContent(content, groupCount) {
    const buckets = Array.from({ length: groupCount + 1 }, () => []);
    if (!content.length) return buckets;
    if (!groupCount) {
        buckets[0].push(...content);
        return buckets;
    }
    if (content.length === 1) {
        buckets[groupCount].push(content[0]);
        return buckets;
    }
    content.forEach((entry, index) => {
        const bucket = Math.round((index * groupCount) / (content.length - 1));
        buckets[bucket].push(entry);
    });
    return buckets;
}

function isClusteredToolTurn(entries) {
    const users = entries.filter(isUser);
    const tools = entries.filter(isLocalTool);
    const content = entries.filter((entry) => !isUser(entry) && !isLocalTool(entry));
    if (!users.length || !tools.length || !content.length) return false;
    return Math.min(...tools.map(sourceOrder)) < Math.min(...users.map(sourceOrder));
}

// Schema 11 and earlier could retain ToolBox calls while a later thread/read
// replaced every Codex Item in the Turn. That left the durable tool batches in
// their original, gapped source-order slots and moved the replacement user and
// assistant Items after them. Repair only that recognizable legacy shape. New
// projections keep the live order in SQLite and do not enter this path.
function repairTurn(entries) {
    const ordered = [...entries].sort((left, right) => sourceOrder(left) - sourceOrder(right));
    const users = ordered.filter(isUser);
    const tools = ordered.filter(isLocalTool);
    const content = ordered.filter((entry) => !isUser(entry) && !isLocalTool(entry));
    if (!users.length) return ordered;

    const clusteredAfterReload = isClusteredToolTurn(ordered);

    if (!clusteredAfterReload) {
        const firstUserIndex = ordered.findIndex(isUser);
        if (firstUserIndex <= 0) return ordered;
        return [ordered[firstUserIndex], ...ordered.slice(0, firstUserIndex), ...ordered.slice(firstUserIndex + 1)];
    }

    const toolGroups = groupConsecutiveTools(tools);
    const contentBuckets = distributeContent(content, toolGroups.length);
    const repaired = [...users, ...contentBuckets[0]];
    toolGroups.forEach((group, index) => {
        repaired.push(...group, ...contentBuckets[index + 1]);
    });
    return repaired;
}

function logicalTimelineOrder(entries = []) {
    const ordered = [...entries].sort((left, right) => (
        sourceOrder(left) - sourceOrder(right)
        || number(left?.createdAt ?? left?.created_at) - number(right?.createdAt ?? right?.created_at)
    ));
    const groups = new Map();
    ordered.forEach((entry, index) => {
        const key = turnKey(entry) || `message:${entry?.messageId ?? entry?.message_id ?? index}`;
        const group = groups.get(key) || { index, entries: [] };
        group.entries.push(entry);
        groups.set(key, group);
    });
    return [...groups.values()].map((group) => {
        const repaired = repairTurn(group.entries);
        const user = repaired.find(isUser);
        return {
            ...group,
            order: user ? sourceOrder(user) : Math.min(...repaired.map(sourceOrder)),
            entries: repaired,
        };
    }).sort((left, right) => left.order - right.order || left.index - right.index)
        .flatMap((group) => group.entries);
}

function projectionMessagesInLogicalOrder(messages = []) {
    const ordered = logicalTimelineOrder(messages);
    const changed = ordered.some((message, index) => message !== messages[index]);
    return changed ? ordered.map((message, index) => ({ ...message, sourceOrder: index + 1 })) : messages;
}

function hasClusteredToolTurn(entries = []) {
    const groups = new Map();
    for (const entry of entries) {
        const key = turnKey(entry);
        if (!key) continue;
        const group = groups.get(key) || [];
        group.push(entry);
        groups.set(key, group);
    }
    return [...groups.values()].some(isClusteredToolTurn);
}

module.exports = {
    hasClusteredToolTurn,
    logicalTimelineOrder,
    projectionMessagesInLogicalOrder,
};
