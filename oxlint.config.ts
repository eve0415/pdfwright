import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'node', 'promise', 'vitest'],
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/src/index.ts' }],
  ignorePatterns: ['dist', 'tools/oxlint/anti-slop'],
  options: {
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: 'error',
  },
  categories: {
    correctness: 'error',
    suspicious: 'error',
    pedantic: 'error',
    perf: 'error',
    style: 'error',
    restriction: 'error',
    nursery: 'error',
  },
  rules: {
    'array-callback-return': ['error', { checkForEach: true }],
    curly: ['error', 'multi-line'],
    'func-style': ['error', 'expression', { allowArrowFunctions: true }],
    'no-bitwise': ['error', { allow: ['~'], int32Hint: true }],
    // import/consistent-type-specifier-style requires types to come from a separate top-level `import type`, which this rule at its default rejects as a second import of the same module.
    'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
    // A `void` statement is the one form typescript/no-floating-promises accepts for a promise deliberately not awaited, and promise/prefer-await-to-then rejects the `.catch()` that would otherwise be it.
    // At its default this rule's fix rewrites `void f();` to `undefined;`, deleting the call, so the three rules have no fixed point and the fixer destroys code.
    // `void` as an expression stays rejected.
    'no-void': ['error', { allowAsStatement: true }],
    'sort-imports': ['error', { allowSeparatedGroups: true, ignoreDeclarationSort: true }],
    'unicorn/filename-case': ['error', { case: 'camelCase' }],
    'unicorn/numeric-separators-style': ['error', { onlyIfContainsSeparator: true }],
    'typescript/return-await': ['error', 'error-handling-correctness-only'],
    'typescript/strict-boolean-expressions': ['error', { allowNullableString: true }],

    'no-undef': 'off',
    'no-undefined': 'off',
    'unicorn/no-null': 'off',
    'no-ternary': 'off',
    'oxc/no-async-await': 'off',
    'oxc/no-optional-chaining': 'off',
    'oxc/no-rest-spread-properties': 'off',
    'node/no-top-level-await': 'off',
    'promise/catch-or-return': 'off',
    'no-inline-comments': 'off',
    'no-underscore-dangle': 'off',
    // It and typescript/promise-function-async contradict each other on a function that returns a promise and awaits nothing: this one rejects the `async`, that one requires it.
    // Its fix inserts a space before the keyword instead of removing it, so the fixer never settles the pair.
    // promise-function-async is the one kept, because a promise-returning function reads as asynchronous at its call site whether or not its body awaits.
    'require-await': 'off',
    // oxfmt lowercases numeric literals and runs after the linter, so this rule's uppercase fix is undone on every formatting pass.
    'unicorn/number-literal-case': 'off',
    // Its fix rewrites `JSON.parse(JSON.stringify(x))` into `structuredClone(x)`, which keeps the `Date`, `Map` and `Set` values the JSON round trip drops.
    // The lint script applies dangerous fixes, so that change in behaviour would land without review.
    'unicorn/prefer-structured-clone': 'off',

    'import/no-default-export': 'off',
    'import/prefer-default-export': 'off',
    'import/no-named-export': 'off',
    'import/group-exports': 'off',
    'import/exports-last': 'off',
    'import/extensions': 'off',
    'import/unambiguous': 'off',
    'import/no-relative-parent-imports': 'off',

    'typescript/explicit-function-return-type': 'off',
    'typescript/explicit-module-boundary-types': 'off',
    'typescript/explicit-member-accessibility': 'off',
    'typescript/prefer-readonly-parameter-types': 'off',

    'id-length': 'off',
    'id-match': 'off',
    'id-denylist': 'off',
    'no-magic-numbers': 'off',
    'sort-keys': 'off',
    'one-var': 'off',
    'capitalized-comments': 'off',
    'func-names': 'off',
    'max-statements': 'off',
    'max-lines': 'off',
    'max-lines-per-function': 'off',
    'no-continue': 'off',
    'no-plusplus': 'off',
    'prefer-named-capture-group': 'off',
    'vars-on-top': 'off',
    'import/max-dependencies': 'off',

    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    // Narrowing an `unknown` value with `typeof` and `in` is how this repository reads untyped input, and both rules reject that pattern.
    'anti-slop/no-runtime-typeof': 'off',
    'anti-slop/no-unknown-parameters': 'off',
  },
  overrides: [
    {
      files: ['scripts/**/*.ts', '**/*.config.ts'],
      rules: {
        'import/no-nodejs-modules': 'off',
      },
    },
    {
      // The vitest rules read any module-level statement as test setup, so outside a test file they fire on ordinary top-level code.
      files: ['**/*.ts'],
      rules: {
        'vitest/require-hook': 'off',
      },
    },
    {
      files: ['**/*.test.ts'],
      rules: {
        'vitest/require-hook': 'error',
        'vitest/prefer-expect-assertions': 'off',
        'vitest/require-test-timeout': 'off',
        // The rule assumes Vitest runs with globals enabled, which this repository does not, and its fix deletes the import, leaving a test file that cannot run.
        'vitest/no-importing-vitest-globals': 'off',
      },
    },
    {
      files: ['scripts/**/*.ts'],
      rules: {
        'no-console': 'off',
        'node/no-sync': 'off',
      },
    },
  ],
});
