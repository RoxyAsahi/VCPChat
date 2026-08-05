'use strict';

const {
    BLOCK_CONTENT_SCHEMA_VERSION,
    normalizeApplyState,
    normalizeSessionConfig,
} = require('../dataContracts');

function parseJson(value, fallback) {
    try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function mapSessionRow(row) {
    return {
        sessionId: row.session_id,
        threadId: row.codex_thread_id,
        agentId: row.agent_id,
        agentCatalogId: row.agent_catalog_id || null,
        agentNameSnapshot: row.agent_name_snapshot || null,
        title: row.title,
        workspaceRoot: row.workspace_root,
        state: row.state,
        pinnedAt: row.pinned_at || null,
        configSnapshot: normalizeSessionConfig(parseJson(row.config_snapshot_json, {})),
        configRevision: Number(row.config_revision || 1),
        appliedRuntimeConfig: normalizeSessionConfig(parseJson(row.applied_config_snapshot_json, {})),
        appliedRuntimeConfigRevision: Number(row.applied_config_revision || 0),
        configApplyState: normalizeApplyState(row.config_apply_state,
            row.codex_thread_id ? 'pending' : 'unmaterialized'),
        configApplyError: row.config_apply_error || null,
        configApplyUpdatedAt: row.config_apply_updated_at || null,
        orphaned: row.orphaned === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
    };
}

function mapBlockRow(row) {
    return {
        blockId: row.block_id,
        kind: row.kind,
        status: row.status,
        ordinal: row.ordinal,
        content: parseJson(row.content_json, {}),
        contentSchemaVersion: Number(row.content_schema_version || BLOCK_CONTENT_SCHEMA_VERSION),
        authority: row.authority || 'codex',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapOperationRow(row) {
    return {
        operationId: row.operation_id,
        sessionId: row.session_id || null,
        kind: row.kind,
        state: row.state,
        threadId: row.codex_thread_id || null,
        payload: parseJson(row.payload_json, {}),
        lastError: row.last_error || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = { mapBlockRow, mapOperationRow, mapSessionRow };
