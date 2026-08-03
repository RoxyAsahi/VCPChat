function createSidebarViewState() {
    return {
        tab: 'agents', agentSearch: '', topicSearch: '', topicSearchResults: [],
        topicSearchLoading: false, topicSearchError: '', topicSearchOpen: false,
        topicManaging: false, topicSelectedIds: new Set(), showArchivedTopics: false,
        topicListLoading: false,
    };
}

export { createSidebarViewState };
