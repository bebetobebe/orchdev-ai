export const COMMAND_IDS = {
    start: 'orchdev-ai.start',
    openPanel: 'orchdev-ai.openPanel',
    newSession: 'orchdev-ai.newSession',
    newTask: 'orchdev-ai.newTask',
    refreshViews: 'orchdev-ai.refreshViews',
    selectSession: 'orchdev-ai.selectSession',
    deleteSession: 'orchdev-ai.deleteSession',
    cancelTask: 'orchdev-ai.cancelTask',
    setRelayToken: 'orchdev-ai.setRelayToken',
    clearRelayToken: 'orchdev-ai.clearRelayToken',
    setCustomApiKey: 'orchdev-ai.setCustomApiKey',
    quickSetupCustomApi: 'orchdev-ai.quickSetupCustomApi',
    testCustomApi: 'orchdev-ai.testCustomApi',
    createSelfCheckTask: 'orchdev-ai.createSelfCheckTask',
    clearCustomApiKey: 'orchdev-ai.clearCustomApiKey',
} as const;

export const VIEW_IDS = {
    panel: 'orchdevAi',
    container: 'orchdev-ai-view-container',
    sessions: 'orchdev-ai-sessions-view',
    tasks: 'orchdev-ai-tasks-view',
} as const;

export const CONTEXT_KEYS = {
    hasSessions: 'orchdevAi.hasSessions',
    hasActiveSession: 'orchdevAi.hasActiveSession',
} as const;

export const EXTENSION_IDS = {
    current: 'orchdev-ai-local.orchdev-ai',
    legacy: 'ai-dev-orchestrator-local.ai-dev-orchestrator',
} as const;
