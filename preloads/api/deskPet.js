'use strict';

// 桌宠：从当前 agent 打开/关闭桌宠窗口。
// 主进程：modules/ipc/deskPetHandlers.js
const { invoke, on, send } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/deskPetHandlers.js'],
    roles: ['chat'],
    api: {
        toggleDeskPet: invoke('deskpet:toggle', 'agentId'),
        getDeskPetOpenAgents: invoke('deskpet:get-open-agents'),
        onDeskPetStateChanged: on('deskpet:state-changed'),
        // 桌宠上输入的话由主窗口按正常流程发送；结果回给主进程。
        onDeskPetSendRequest: on('deskpet:send-request'),
        deskPetSendResult: send('deskpet:send-result', 'payload'),
        // 点桌宠上 AI 主动开的新话题：切到那个话题。
        onDeskPetOpenTopic: on('deskpet:open-topic'),
    },
};
