'use strict';

// Clean-room data-only port of the normalization boundary used by OpenCode's
// session-diff (MIT, a45c2b917e). It never applies a patch and never guesses
// a diff from Markdown; Codex fileChange.changes is the sole source.
const MAX_FILES = 16;
const MAX_PATCH_CHARS = 128 * 1024;

function changeStatus(kind) {
    const value = String(kind || '').toLowerCase();
    if (['add', 'added', 'create', 'created'].includes(value)) return 'added';
    if (['delete', 'deleted', 'remove', 'removed'].includes(value)) return 'deleted';
    return 'modified';
}

function countPatchLines(patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of String(patch || '').split(/\r?\n/)) {
        if (line.startsWith('+++')) continue;
        if (line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        if (line.startsWith('-')) deletions += 1;
    }
    return { additions, deletions };
}

function normalizeCodexFileChanges(changes) {
    let remaining = MAX_PATCH_CHARS;
    const files = [];
    for (const change of Array.isArray(changes) ? changes.slice(0, MAX_FILES) : []) {
        const path = String(change?.path || '').trim();
        const patch = String(change?.diff || '');
        if (!path || !patch) continue;
        const visiblePatch = patch.slice(0, Math.max(0, remaining));
        remaining -= visiblePatch.length;
        const counts = countPatchLines(visiblePatch);
        files.push({
            path,
            status: changeStatus(change.kind),
            patch: visiblePatch,
            truncated: visiblePatch.length !== patch.length,
            ...counts,
        });
        if (remaining <= 0) break;
    }
    return {
        files,
        truncated: (Array.isArray(changes) ? changes.length : 0) > files.length || remaining <= 0,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
}

module.exports = { MAX_FILES, MAX_PATCH_CHARS, countPatchLines, normalizeCodexFileChanges };
