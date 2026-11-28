import { defineConfig } from 'oxfmt';

export default defineConfig({
  arrowParens: 'avoid',
  singleQuote: true,
  printWidth: 160,
  sortImports: {
    groups: [['type'], ['builtin'], ['external'], ['subpath', 'internal'], ['parent'], ['sibling'], ['index']],
  },
});
