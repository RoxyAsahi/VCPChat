'use strict';

// 桌宠：从当前 agent 打开/关闭桌宠窗口。
// 主进程：modules/ipc/deskPetHandlers.js
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/deskPetHandlers.js'],
    roles: ['chat'],
    api: {
        toggleDeskPet: invoke('deskpet:toggle', 'agentId'),
        getDeskPetOpenAgents: invoke('deskpet:get-open-agents'),
        onDeskPetStateChanged: on('deskpet:state-changed'),
    },
};
