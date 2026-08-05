'use strict';

const { CodexAppServerError } = require('./appServerTransport');
const { normalizeInstructionMode, normalizePersonality } = require('./runtime-normalizers');
const { CODEX_CAPABILITIES, isCodexCapabilityEnabled, normalizeToolPolicy } = require('./tool-policy');

class RuntimePolicyService {
    constructor(context) {
        this.context = Object.freeze(context);
    }

    runtimePolicyParams(config = {}, { starting = false } = {}) {
        const provider = this.context.providerParams();
        if (config.executionProfile !== 'toolbox-only') return provider;
        const toolPolicy = normalizeToolPolicy(config.toolPolicy == null ? {
            preset: 'custom', enabledCodexCapabilities: [], enabledVcpTools: ['vcp:*'],
        } : config.toolPolicy);
        const shellEnabled = isCodexCapabilityEnabled(toolPolicy, CODEX_CAPABILITIES.SHELL)
            || isCodexCapabilityEnabled(toolPolicy, CODEX_CAPABILITIES.WORKSPACE_WRITE);
        const planEnabled = isCodexCapabilityEnabled(toolPolicy, CODEX_CAPABILITIES.PLAN);
        return {
            ...provider,
            config: {
                ...(provider.config || {}),
                include_permissions_instructions: false,
                include_apps_instructions: false,
                include_collaboration_mode_instructions: false,
                include_environment_context: false,
                project_doc_max_bytes: 0,
                'skills.include_instructions': false,
                model_reasoning_summary: 'detailed',
                web_search: 'disabled',
                mcp_servers: {},
                'tools.update_plan.enabled': planEnabled,
                'tools.experimental_request_user_input.enabled': false,
                'features.shell_tool': shellEnabled,
                'features.deferred_executor': false,
                'features.request_permissions_tool': false,
                'features.standalone_web_search': false,
                'features.memory_tool': false,
                'features.collab': false,
                'features.multi_agent_v2': false,
                'features.apps': false,
                'features.enable_mcp_apps': false,
                'features.tool_suggest': false,
                'features.plugins': false,
                'features.token_budget': false,
                'features.current_time_reminder': false,
            },
            ...(starting ? { environments: [] } : {}),
        };
    }

    threadInstructionParams(config = {}) {
        if (config.executionProfile && config.executionProfile !== 'toolbox-only') {
            return {
                ...(String(config.baseInstructions || '').trim()
                    ? { baseInstructions: String(config.baseInstructions).trim() } : {}),
                ...(String(config.developerInstructions || '').trim()
                    ? { developerInstructions: String(config.developerInstructions).trim() } : {}),
                ...(normalizePersonality(config.personality) !== 'none'
                    ? { personality: normalizePersonality(config.personality) } : {}),
            };
        }
        const mode = normalizeInstructionMode(config.instructionMode, config.baseInstructions);
        if (mode === 'codex-managed') {
            const personality = normalizePersonality(config.personality);
            return {
                ...(personality !== 'none' ? { personality } : {}),
                ...(String(config.developerInstructions || '').trim()
                    ? { developerInstructions: String(config.developerInstructions).trim() } : {}),
            };
        }
        const baseInstructions = String(config.baseInstructions || '').trim();
        if (!baseInstructions) {
            throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'VChat identity mode requires baseInstructions');
        }
        return { baseInstructions };
    }
}

module.exports = { RuntimePolicyService };
