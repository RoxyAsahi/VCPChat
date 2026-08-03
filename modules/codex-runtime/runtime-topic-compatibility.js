'use strict';

function installRuntimeTopicCompatibility(RuntimeManager) {
    Object.assign(RuntimeManager.prototype, {
        createTopic(options = {}) { return this.createSessionRecord(options); },
        listTopics(options = {}) { return this.listSessions(options); },
        readTopic(options = {}) { return this.readSession(options); },
        renameTopic(options = {}) { return this.renameSession(options); },
        deleteTopic({ sessionId } = {}) { return this.archiveSession({ sessionId }); },
        searchTopics(options = {}) { return this.searchSessions(options); },
        searchTopicMessages(options = {}) { return this.searchSessionMessages(options); },
    });
    return RuntimeManager;
}

module.exports = { installRuntimeTopicCompatibility };
