import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            'dist/**',
            'coverage/**',
            'node_modules/**',
            'migrations/**',
            'migrate-mongo-config.js',
            '.husky/**',
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    eslintConfigPrettier,
    {
        plugins: { '@stylistic': stylistic, import: importPlugin },
        settings: {
            'import/resolver': {
                typescript: { project: ['tsconfig.json', 'tsconfig.scripts.json'] },
            },
        },
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@stylistic/padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: '*', next: 'return' },
                { blankLine: 'always', prev: '*', next: ['if', 'for'] },
                { blankLine: 'always', prev: ['if', 'for'], next: '*' },
            ],
            'import/order': [
                'error',
                {
                    groups: [
                        ['builtin', 'external'],
                        ['internal', 'parent', 'sibling', 'index'],
                    ],
                    'newlines-between': 'always',
                },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
            '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
            '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
            '@typescript-eslint/unbound-method': 'off',
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
                { selector: 'import', format: null },
                {
                    selector: 'variable',
                    format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
                    leadingUnderscore: 'allow',
                },
                { selector: 'function', format: ['camelCase', 'PascalCase'] },
                { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'enumMember', format: ['UPPER_CASE', 'PascalCase'] },
                { selector: 'classMethod', format: ['camelCase'] },
                {
                    selector: 'classProperty',
                    format: ['camelCase', 'snake_case', 'UPPER_CASE'],
                    leadingUnderscore: 'allow',
                },
                {
                    selector: ['objectLiteralProperty', 'typeProperty', 'objectLiteralMethod', 'typeMethod'],
                    format: null,
                },
            ],
        },
    },
    {
        files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },
    {
        files: ['**/*.mjs', '**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ['load/**/*.js'],
        languageOptions: {
            globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
        },
    },
);
