import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [...cloudflare.ignorePatterns, 'dist', 'tools/oxlint/anti-slop'],
  options: {
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: 'error',
  },
  rules: {
    // A variable a closure reads before its one assignment cannot be const: declared at the assignment, a call to the closure before it would throw a ReferenceError.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    // The rule takes any function whose name starts with `use` for a React hook, and this repository has no React.
    'react-hooks/rules-of-hooks': 'off',
    'import/no-nodejs-modules': 'error',

    curly: 'off',
    'typescript/array-type': 'off',
    'unicorn/numeric-separators-style': 'off',
    'quality/no-array-filter-map': 'off',
    '@nkzw/no-instanceof': 'off',
  },
  overrides: [
    {
      files: ['scripts/**/*.ts', '**/*.config.ts', '**/*.oracle.test.ts'],
      rules: {
        'import/no-nodejs-modules': 'off',
      },
    },
    {
      files: ['scripts/**/*.ts'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
});
