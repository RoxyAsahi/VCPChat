const correctnessRules = {
    // All canonical Agent host code is governed by the final complexity ceiling.
    complexity: ['error', 29],
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-class-assign': 'error',
    'no-compare-neg-zero': 'error',
    'no-const-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-func-assign': 'error',
    'no-import-assign': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-obj-calls': 'error',
    'no-self-assign': 'error',
    'no-setter-return': 'error',
    'no-sparse-arrays': 'error',
    'no-unexpected-multiline': 'error',
    'no-unreachable': 'error',
    'no-unreachable-loop': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-unsafe-optional-chaining': 'error',
    'no-useless-backreference': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
};

export default [
    {
        files: ['modules/codex-runtime/**/*.js'],
        ignores: ['modules/codex-runtime/projection/migrations/**'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
        },
        rules: correctnessRules,
    },
    {
        files: ['modules/ui-system/agent-store/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: { ...correctnessRules, complexity: ['error', 29] },
    },
    {
        files: [
            'modules/ui-system/agent-*.js',
            'modules/ui-system/agent-presentation/**/*.js',
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: correctnessRules,
    },
];
