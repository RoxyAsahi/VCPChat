'use strict';

function rejectConfigApplyTargets(targets, error) {
    for (const target of targets.values()) {
        clearTimeout(target.timeout);
        target.reject?.(error);
    }
    targets.clear();
}

module.exports = { rejectConfigApplyTargets };
