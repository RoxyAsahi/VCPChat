(function (global) {
    'use strict';

    const managers = {
        tempera: global.MusicStageTemperaManager,
        sonnet: global.MusicStageSonnetManager,
        diorama: global.MusicStageDioramaManager,
        fume: global.MusicStageFumeManager,
        tunnel: global.MusicStageTunnelManager,
        kowloon: global.MusicStageKowloonManager,
        inkdraft: global.MusicStageInkdraftManager,
        fogpane: global.MusicStageFogpaneManager,
        lumiere: global.MusicStageLumiereManager
    };

    const definitions = [
        { id: 'tempera', label: '凝彩', manager: managers.tempera },
        { id: 'sonnet', label: '商籁', manager: managers.sonnet },
        { id: 'diorama', label: '镜台', manager: managers.diorama },
        { id: 'fume', label: '浮名', manager: managers.fume },
        { id: 'tunnel', label: '隧图', manager: managers.tunnel },
        { id: 'kowloon', label: '町景', manager: managers.kowloon },
        { id: 'inkdraft', label: '墨痕', manager: managers.inkdraft },
        { id: 'fogpane', label: '雾笺', manager: managers.fogpane },
        { id: 'lumiere', label: '绘光', manager: managers.lumiere }
    ];

    global.MusicStageAdvancedModes = Object.freeze({
        entries: Object.freeze(definitions
            .filter((entry) => entry.manager?.create)
            .map((entry) => Object.freeze({
                id: entry.id,
                label: entry.label,
                create(container, services) {
                    return entry.manager.create(container, services);
                }
            })))
    });
})(window);