'use strict';

// 边栏子聊（Workspace Side Chat）：上下文快照、元数据读写与生命周期
// 主进程：modules/ipc/sideChatHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/sideChatHandlers.js'],
    roles: ['chat', 'utility', 'desktop'],
    api: {
        createSideChatSnapshot: invoke('side-chat:create-snapshot', 'agentId', 'parentTopicId', 'childTopicId'),
        saveSideChatMetadata: invoke('side-chat:save-metadata', 'metadata'),
        getSideChatMetadata: invoke('side-chat:get-metadata', 'agentId', 'childTopicId'),
        listSideChatMetadata: invoke('side-chat:list-metadata', 'agentId', 'parentTopicId'),
        deleteSideChatMetadata: invoke('side-chat:delete-metadata', 'agentId', 'childTopicId'),
    },
};
