'use strict';

const path = require('path');
const fs = require('fs');
const { fail, ERROR_CODES } = require('./errors');

function canonicalizeWorkspaceRoot(rootPath) {
    if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
        fail(ERROR_CODES.WORKSPACE_INVALID, 'Workspace root must be a non-empty path');
    }
    const resolved = path.resolve(rootPath);
    let real;
    try {
        real = fs.realpathSync.native(resolved);
    } catch (error) {
        fail(ERROR_CODES.WORKSPACE_INVALID, `Workspace root does not exist: ${resolved}`, {
            cause: error.message,
        });
    }
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) {
        fail(ERROR_CODES.WORKSPACE_INVALID, `Workspace root is not a directory: ${real}`);
    }
    return real;
}

function isPathInsideRoot(rootRealPath, candidatePath) {
    const resolved = path.resolve(rootRealPath, candidatePath);
    const relative = path.relative(rootRealPath, resolved);
    if (relative === '') {
        return true;
    }
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return false;
    }
    return true;
}

function resolveInsideRoot(rootRealPath, candidatePath) {
    if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT, 'Candidate path must be a non-empty string');
    }
    const resolved = path.resolve(rootRealPath, candidatePath);
    if (!isPathInsideRoot(rootRealPath, resolved)) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT,
            `Path escapes workspace root: ${candidatePath}`,
            { root: rootRealPath });
    }
    let real = resolved;
    try {
        real = fs.realpathSync.native(resolved);
    } catch (error) {
        // Path may not exist yet (write targets); check nearest existing ancestor for symlink escape.
        let ancestor = path.dirname(resolved);
        while (ancestor && ancestor !== path.dirname(ancestor)) {
            try {
                const ancestorReal = fs.realpathSync.native(ancestor);
                const remainder = path.relative(ancestor, resolved);
                real = path.join(ancestorReal, remainder);
                break;
            } catch (innerError) {
                const parent = path.dirname(ancestor);
                if (parent === ancestor) {
                    break;
                }
                ancestor = parent;
            }
        }
    }
    if (!isPathInsideRoot(rootRealPath, real)) {
        fail(ERROR_CODES.WORKSPACE_OUTSIDE_ROOT,
            `Resolved path escapes workspace root (symlink/junction): ${candidatePath}`,
            { root: rootRealPath, resolved: real });
    }
    return real;
}

function scanArgumentsForPaths(args, visitor) {
    const findings = [];
    function walk(value, keyPath) {
        if (value === null || value === undefined) {
            return;
        }
        if (typeof value === 'string') {
            if (visitor(keyPath, value)) {
                findings.push({ keyPath, value });
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${keyPath}[${index}]`));
            return;
        }
        if (typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                walk(item, keyPath ? `${keyPath}.${key}` : key);
            }
        }
    }
    walk(args, '');
    return findings;
}

const PATH_KEY_PATTERN = /path|file|dir|directory|folder|cwd|target|destination|source/i;

function findSuspiciousPathArguments(args) {
    return scanArgumentsForPaths(args, (keyPath, value) => {
        if (!PATH_KEY_PATTERN.test(keyPath)) {
            return false;
        }
        return /(^|[\\/])\.\.([\\/]|$)/.test(value)
            || /^[A-Za-z]:[\\/]/.test(value)
            || value.startsWith('\\\\')
            || path.isAbsolute(value);
    });
}

module.exports = {
    canonicalizeWorkspaceRoot,
    isPathInsideRoot,
    resolveInsideRoot,
    findSuspiciousPathArguments,
    PATH_KEY_PATTERN,
};
