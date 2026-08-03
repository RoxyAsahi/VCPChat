import assert from 'node:assert/strict';
import {
    protectLatexBlocks,
    restoreLatexBlocks,
} from '../modules/ui-system/agent-presentation/fork/agent-renderer-latex.js';

const source = [
    '价格是 $12.50 USD',
    '路径是 $PATH',
    '公式是 $x^2$.',
    '',
    '```python',
    "assert b'$$' in data",
    '```',
    '',
    '$$',
    '\\frac{1}{2}',
    '$$',
    '',
    '<span>$35.50</span> 与 <strong>$y$</strong>',
].join('\n');

const protectedResult = protectLatexBlocks(source);
assert.equal(protectedResult.text.includes("assert b'$$' in data"), true, 'code fences remain byte-for-byte intact');
assert.equal(protectedResult.text.includes('%%LATEX_BLOCK_'), true, 'math is protected before Markdown parsing');
assert.equal([...protectedResult.map.values()].some((value) => value.includes('12.50') || value.includes('PATH')), false,
    'prices and environment-style tokens must not enter the LaTeX map');
assert.equal([...protectedResult.map.values()].some((value) => value === '\\(x^2\\)'), true);
assert.equal([...protectedResult.map.values()].some((value) => value.includes('\\frac{1}{2}')), true);
assert.equal([...protectedResult.map.values()].some((value) => value === '\\(y\\)'), true,
    'inline math inside one HTML text node remains supported');

const restored = restoreLatexBlocks(protectedResult.text, protectedResult.map);
assert.equal(restored, source.replace('$x^2$', '\\(x^2\\)').replace('$y$', '\\(y\\)'),
    'restore changes only supported single-dollar math to explicit delimiters');
assert.equal(restoreLatexBlocks('plain', new Map()), 'plain');

console.log('Agent renderer LaTeX ownership tests passed.');
