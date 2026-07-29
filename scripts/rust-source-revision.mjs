import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A Git commit is not an honest build identity while the Rust source tree has
// uncommitted changes. Hash the exact daemon workspace inputs instead. The
// result stays a 64-char hex value, which the framed v1.2 ready contract can
// validate without exposing a path or user-specific timestamp.
function rustSourceRevision(projectRoot) {
    const sourceRoot = path.join(projectRoot, 'rust');
    const files = [];
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'target' || entry.name === '.git') continue;
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else if (entry.isFile()) files.push(fullPath);
        }
    }
    visit(sourceRoot);
    const hash = crypto.createHash('sha256');
    for (const file of files.sort((left, right) => left.localeCompare(right))) {
        hash.update(path.relative(projectRoot, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

export { rustSourceRevision };
