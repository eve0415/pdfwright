# pdfwright

pdfwright is a TypeScript PDF library for print production, licensed MIT OR Apache-2.0. Its packages are built for npm as ESM with type declarations, and library code uses web-standard APIs only, so that the same build runs on Node, Deno, Bun, Cloudflare Workers and browsers.

## Layout

- `packages/core` is `@pdfwright/core`, the core package.
- `packages/illustrator` is `@pdfwright/illustrator`, which writes Illustrator-layered PDFs from a print-production artwork model.
- `tests/` holds tests that span packages. `runtime.test.ts` asserts that every Vitest project runs its test bodies in the runtime it names and that every package entry loads there.
- `scripts/` holds repository scripts, which run on Node.
- `tools/oxlint/anti-slop` is a git submodule, the [anti-slop](https://github.com/dmmulroy/anti-slop) oxlint plugin (MIT), loaded as a JS plugin.

## Setup

```sh
git clone --recurse-submodules https://github.com/eve0415/pdfwright.git
cd pdfwright
pnpm install
pnpm exec playwright install --with-deps --only-shell chromium
```

Install pnpm 11 or newer from <https://pnpm.io/installation>. pnpm downloads and runs the version the `packageManager` field pins (its `pmOnFail` setting defaults to `download`), and it installs the Node version `devEngines.runtime` pins into `node_modules/.bin`, where package scripts find it. Bun and Deno are npm devDependencies, so `pnpm install` provides them too.

oxlint fails to start without the anti-slop submodule. In a clone made without `--recurse-submodules`, run `git submodule update --init --recursive`.

## The gate

`pnpm run check` runs the following checks in order.

```sh
pnpm exec oxlint
pnpm exec oxfmt --check
pnpm run check:type-aware-coverage
pnpm test            # the node, browser (headless Chromium), workers (workerd) and oracle projects
pnpm run test:bun
pnpm run test:deno
pnpm run build
```

Run each as a separate command and read its exit code. **Never pipe the gate into `head` or `tail` before reading its exit code**: a pipeline exits with the status of its last command, so a failure reads as a pass. CI (`.github/workflows/ci.yaml`) runs the same checks, with the test projects split across jobs.

`pnpm lint` is the fix mode: it applies every oxlint fix, including the ones oxlint marks dangerous, formats with oxfmt, and then runs the coverage check. Review its diff before committing it.

- **oxlint is the type checker.** It runs type-aware with `typeCheck` on, so it reports TypeScript's own diagnostics, and there is no separate `tsc` step.
- **A file no tsconfig covers is checked with TypeScript's default options, not this repository's** (<https://github.com/oxc-project/oxc/issues/26822>). `check:type-aware-coverage` plants a type error that only the repository's options report in every `packages/*/src`, in `scripts/`, in `tests/`, and in a `*.config.ts` file at the root and in each package, and fails unless oxlint reports each one. A new TypeScript directory needs a tsconfig whose `include` covers it; config files are covered by `tsconfig.config.json`.
- **oxlint does not report `isolatedDeclarations` errors (TS9xxx).** The tsdown build reports them when it emits declarations, so a change to an exported signature is checked only once `pnpm run build` passes.
- **`test:bun` and `test:deno` start `node_modules/vitest/vitest.mjs` directly.** The `node_modules/.bin/vitest` shim runs Node whichever runtime launched it. Their `--project bun` and `--project deno` filters turn a run in the wrong runtime into a `No projects were found` error rather than a pass.

The oracle project runs on Node and checks generated files with qpdf. The devcontainer also installs Ghostscript, MuPDF, poppler-utils, LittleCMS, Argyll, free ICC profiles and the Noto CJK fonts for external checks.

## Runtime rules

- **Library source uses web-standard APIs only**: no Node built-ins, no WebAssembly, no native code. oxlint's `import/no-nodejs-modules` rejects `node:` imports in `packages/*/src` and `tests/` except oracle tests, the root tsconfig sets `types: []` so Node globals such as `process` and `Buffer` do not type-check, and the browser project runs the suite where neither exists.
- **The workers project cannot prove the absence of Node APIs**, because `@cloudflare/vitest-plugin` enables `nodejs_compat`. The lint rule, the tsconfigs and the browser project are what enforce the rule above.
- **`scripts/` and `*.config.ts` run on Node** and may import `node:` modules.

## Type safety

Banned in source: `any`, `as` except `as const`, non-null assertions (`x!`), `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error` outside tests, and lint-disable comments. Each one hides a type error instead of fixing it.

Narrow `unknown` with `typeof`, `in` and equality checks, and validate untrusted input where it enters. Exported declarations carry explicit types, because `isolatedDeclarations` is on in every package.

## Specifications

Code that implements behaviour a specification defines cites the clause in a comment, for example `// ISO 32000-1:2008, 7.3.4.2`. The specifications are ISO 32000-1 and ISO 32000-2 (PDF), ISO 15930-7 (PDF/X-4) and ICC.1 (ICC profiles). A citation lets a reviewer check the code against the text rather than against memory.

## Dependencies

Publish packages with pnpm. npm ignores `publishConfig.exports` and would package source export paths that are absent from the tarball.

- **Pin exact versions** with `pnpm add -E` (`saveExact` is on). A loose range lets a compromised release in on the next install.
- **Commit `pnpm-lock.yaml` in the same commit as the manifest change**, or the commit does not install as it was tested.
- **A version written by hand must be one pnpm's `minimumReleaseAge` accepts** (1440 minutes by default). Never add `minimumReleaseAgeExclude`.
- **A dependency more than one package declares goes in the `catalog`** of `pnpm-workspace.yaml` and is referenced as `catalog:`, so the packages cannot drift apart.
- **`allowBuilds` names every dependency that has an install script**, set to `true` or `false`. `pnpm install` fails on one it does not name.
- **Add or update `bun` and `deno` only through the `npm:` alias form**, with the version inside the alias: `"bun": "npm:bun@1.4.2"`. `pnpm add bun` with the bare name records Bun as the package manager and removes `packageManager`, and the next install fails with `ERR_PNPM_OTHER_PM_EXPECTED`. `pnpm add -E bun@npm:bun` writes an unpinned alias, so check the manifest afterwards.
- **GitHub Actions are pinned to a full commit SHA** with the version in a trailing comment (`# v7.0.1`). A tag can be moved; a commit cannot.

## Commits

Conventional commits (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`) with a lowercase imperative subject that names the change. One concern per commit, and a body of at most about three short lines: a small commit is one a reviewer can read whole and revert alone.

## Prose

Never break a line inside a sentence, in Markdown, comments or commit messages. A line ends where a sentence or paragraph ends. oxfmt preserves line breaks in Markdown, so a hard-wrapped sentence stays wrapped.

## Fixtures

A test fixture is generated by code in this repository or is licence-clean, with its source and licence recorded next to it. A fixture of unknown origin cannot be redistributed under this repository's licences.
