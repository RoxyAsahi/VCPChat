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
        // 全局设置 → 桌宠（modules/settings/schema/deskpet-panel.js）；主进程：modules/deskpet/settingsPage.js、petControls.js
        onDeskPetSettingsOpen: on('deskpet-settings:open'),
        onDeskPetSettingsChanged: on('deskpet-settings:changed'),
        onDeskPetPreview: on('deskpet-settings:preview'),
        getDeskPetSettings: invoke('deskpet-settings:get'),
        getDeskPetCatalog: invoke('deskpet-settings:catalog', 'agentId'),
        refreshDeskPetCatalog: invoke('deskpet-settings:refresh', 'agentId'),
        chooseDeskPetOutfit: invoke('deskpet-settings:choose', 'agentId', 'outfitId'),
        setDeskPetsVisible: invoke('deskpet-settings:set-visible', 'visible', 'agentId'),
        importDeskPetOutfit: invoke('deskpet-settings:import', 'agentId'),
        openDeskPetFolder: invoke('deskpet-settings:open-folder', 'agentId'),
        installDeskPetCore: invoke('deskpet-settings:core-install', 'source', 'agentId'),
        openDeskPetCoreLink: invoke('deskpet-settings:core-link', 'which'),
        onDeskPetCoreProgress: on('deskpet-settings:core-progress'),
        talkToDeskPet: invoke('deskpet-settings:talk', 'agentId', 'text'),
        updateDeskPetSettings: invoke('deskpet-settings:update', 'patch'),
        setDeskPetShortcut: invoke('deskpet-settings:set-shortcut', 'actionId', 'accelerator'),
        resetDeskPetShortcuts: invoke('deskpet-settings:reset-shortcuts'),
        pauseDeskPetShortcuts: invoke('deskpet-settings:pause-shortcuts', 'paused'),
        setDeskPetScale: invoke('deskpet-settings:set-scale', 'agentId', 'scale'),
    },
};
