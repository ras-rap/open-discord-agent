import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
  {
    'ignores': ['dist/', 'node_modules/', '*.js', '*.cjs'],
  },
  js.configs.recommended,
  {
    'files': ['**/*.ts', '**/*.tsx'],
    'languageOptions': {
      'parser': typescriptParser,
      'parserOptions': {
        'ecmaVersion': 2022,
        'sourceType': 'module',
      },
      'globals': {
        'Bun': 'readonly',
        'process': 'readonly',
        'Buffer': 'readonly',
        '__dirname': 'readonly',
        '__filename': 'readonly',
        'setImmediate': 'readonly',
        'clearImmediate': 'readonly',
        'console': 'readonly',
        'global': 'readonly',
        'Response': 'readonly',
        'Request': 'readonly',
        'URL': 'readonly',
        'fetch': 'readonly',
        'setTimeout': 'readonly',
        'setInterval': 'readonly',
        'clearTimeout': 'readonly',
        'clearInterval': 'readonly',
        'Headers': 'readonly',
      },
    },
    'plugins': {
      '@typescript-eslint': typescript,
      'prettier': prettierPlugin,
      'import': importPlugin,
    },
    'rules': {
      'prettier/prettier': ['error', {}, { 'usePrettierrc': true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'warn',
      'no-dupe-class-members': 'off',
      'no-undef': 'off',
      'quote-props': ['error', 'always'],
      'curly': ['error', 'multi'],

      'import/order': [
        'error',
        {
          'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          'alphabetize': {
            'order': 'asc',
            'caseInsensitive': true,
          },
        },
      ],
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
    },
  },
];
