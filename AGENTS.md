# pdfwright

pdfwright is a TypeScript PDF library for print production, licensed MIT OR Apache-2.0. Its packages are built for npm as ESM with type declarations, and library code uses web-standard APIs only, so that the same build runs on Node, Deno, Bun, Cloudflare Workers and browsers.

## Layout

- `packages/core` is `@pdfwright/core`, the core package.
- `packages/illustrator` is `@pdfwright/illustrator`, which writes Illustrator-layered PDFs from a print-production artwork model.
- `tests/` holds tests that span packages. `runtime.test.ts` asserts that every Vitest project runs its test bodies in the runtime it names, with the fixed property-test seed, and that every package entry loads there. `publicApi.test.ts` imports each package by name, pins the names of its value exports and runs one round trip through each. `setupFastCheck.ts` is the setup file every project loads.
- `scripts/` holds repository scripts, which run on Node.

## Setup

```sh
git clone https://github.com/eve0415/pdfwright.git
cd pdfwright
pnpm install
pnpm exec playwright install --with-deps --only-shell chromium
```

Install pnpm 11 or newer from <https://pnpm.io/installation>. pnpm downloads and runs the version the `packageManager` field pins (its `pmOnFail` setting defaults to `download`), and it installs the Node version `devEngines.runtime` pins into `node_modules/.bin`, where package scripts find it. Bun and Deno are npm devDependencies, so `pnpm install` provides them too.

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
pnpm run check:packages
```

Run each as a separate command and read its exit code. **Never pipe the gate into `head` or `tail` before reading its exit code**: a pipeline exits with the status of its last command, so a failure reads as a pass. CI (`.github/workflows/ci.yaml`) runs the same checks, with the test projects split across jobs.

`pnpm run test:coverage` reports statement and branch coverage of the node project in `coverage/`. It is outside the gate and has no threshold: read its uncovered branches as a list of untested decisions, not as a number to raise.

`pnpm lint` is the fix mode: it applies every oxlint fix, including the ones oxlint marks dangerous, formats with oxfmt, and then runs the coverage check. Review its diff before committing it.

- **The lint rules are `@cloudflare/oxlint-config` plus typescript-eslint's `strict-type-checked` and oxlint's `correctness` category.** `oxlint.config.ts` extends the preset and turns on every strict-type-checked rule, in test files too, where the preset would turn some off. The preset turns every category off, and the config turns `correctness` back on.
- **oxlint is the type checker.** It runs type-aware with `typeCheck` on through `tsrs-lint` from [tsrs](https://github.com/oxc-project/tsrs), the Rust port of the TypeScript 7 compiler, so it reports TypeScript's own diagnostics for every file it lints, and there is no separate `tsc` step.
- **A file no tsconfig covers is checked with TypeScript's default options, not this repository's** (<https://github.com/oxc-project/oxc/issues/26822>). `check:type-aware-coverage` plants a type error that only the repository's options report in every `packages/*/src`, in `scripts/`, in `tests/`, in every directory that holds an `*.oracle.test.ts` file (tracked or not, as Git lists them), and in a `*.config.ts` file at the root and in each package, and fails unless oxlint reports each one. A new TypeScript directory needs a tsconfig whose `include` covers it; config files are covered by `tsconfig.config.json`.
- **oxlint reports `isolatedDeclarations` errors (TS9xxx) in every package source file.** The tsdown build does not report all of them, so `pnpm exec oxlint` is the check for an exported signature.
- **`check:packages` tests what a consumer installs.** It deletes each package's `dist`, builds, packs every package with `pnpm pack`, installs all the tarballs together with `npm install --offline` into a temporary project outside the repository, and imports each package there under Node, Bun and Deno. It fails when a file the published `exports` map names is missing from a tarball, when an import fails, or when the export names a runtime sees differ from the source entry's. It needs an `npm` on `PATH`, which no devDependency provides; the Node installation that ships it is enough.
- **`test:bun` and `test:deno` start `node_modules/vitest/vitest.mjs` directly.** The `node_modules/.bin/vitest` shim runs Node whichever runtime launched it. Their `--project bun` and `--project deno` filters turn a run in the wrong runtime into a `No projects were found` error rather than a pass.

The oracle project runs on Node and checks generated files with qpdf. The devcontainer also installs Ghostscript, MuPDF, poppler-utils, LittleCMS, Argyll, free ICC profiles and the Noto CJK fonts for external checks.

## Tests

Tests are colocated with the code they test, and the file suffix decides where a test runs. `scripts/testCollection.node.test.ts` fails when a test file is collected by no project or by a project its suffix does not name.

- `X.test.ts` runs in the node, browser, workers, Bun and Deno projects.
- `X.oracle.test.ts` runs only in the oracle project, on Node with the external tools installed.
- `X.node.test.ts` runs only in the node project; scripts are tested this way.

| Level       | What it checks                                                                                            | Where                                                    | Runs in                             |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| Static      | types and lint                                                                                            | oxlint with `typeCheck`, and `check:type-aware-coverage` | the gate                            |
| Unit        | one module through its exports: each class of input, both sides of every limit, every kind of error       | `X.test.ts` beside `X.ts`                                | the five runtime projects           |
| Integration | several modules together on PDFs the test generates, in memory, with no doubles of this repository's code | `X.test.ts` beside the entry module                      | the five runtime projects           |
| Property    | round trips and invariants over generated inputs, with fast-check                                         | a `describe('properties')` block in the same `X.test.ts` | the five runtime projects           |
| Oracle      | the library's output as qpdf, Ghostscript, MuPDF, LittleCMS, Chromium and the corpus judge it             | `X.oracle.test.ts`                                       | the oracle project                  |
| Public API  | each package through its name only, and the names it exports                                              | `tests/publicApi.test.ts`                                | the five runtime projects           |
| Package     | the packed tarballs, installed outside the repository and imported                                        | `scripts/checkPackages.ts`                               | Node, Bun and Deno, after the build |

Inside the test suite the package names resolve to the source entries through each package's `exports`; only `check:packages` reads the `publishConfig.exports` that npm consumers receive.

Every new or changed test follows these rules.

- **Test at the lowest level that can see the behaviour.** When an oracle test finds a defect, add a unit test of its cause on a minimal generated input as well, so the next regression does not hide behind a tool install.
- **A fixture must separate the rule from its nearest wrong version.** A symmetric value such as tint 0.5, keys inserted in their sorted order, or a single item where "first" and "any" agree passes a broken implementation too.
- **Test a limit at the limit and one past it**, so that `>` and `>=` cannot be swapped unnoticed.
- **An error assertion names the error class and the field that distinguishes the failure**, such as `reason` or `offset`, never the whole message: `toThrow(XError)` for the class, and `toThrow(expect.objectContaining({ reason: 'image-truncated' }))` for the field. `toThrow(new XError(message))` compares the message and the error's own properties, including `name`, but not its class.
- **Assert the whole output against inputs whose results differ.** A length, a prefix or a "not empty" check passes when most of the output is lost.
- **No double of this repository's own code.** Run the real modules; double only what the repository does not own.
- **No new wall-clock budget in the five runtime projects.** A time limit flakes on a loaded runner and can be vacuous where a clock does not advance; bound work by counting it instead.
- **A property asserts with `expect` inside its predicate**, because `expect.requireAssertions` fails a test that makes no assertion, and states an equality (a round trip, an invariant, agreement with an independent implementation) rather than a range. `setupFastCheck.ts` fixes the seed and the number of runs in every project, and a failure prints the seed and path that replay it.
- **An oracle test that cannot find its tool or a committed corpus fails.** A test that reads a local-only reference file through an environment variable is skipped when the variable is unset, and says so.
- **A test asserts the behaviour the specification or the documentation states.** When the library disagrees, fix the library in the same change or leave the test out; never pin the wrong behaviour.

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
- **`.github/workflows/actions.lock` locks every action a workflow uses**, including the actions those actions call. After changing a `uses:` line, run `gh actions-lock --no-narrow` from the [gh-actions-lock](https://github.com/github/gh-actions-lock) extension and commit the lockfile with the workflow; without `--no-narrow` it rewrites the SHA pins to tags, which zizmor rejects. CI runs `gh actions-lock --verify`.

## Commits

Conventional commits (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`) with a lowercase imperative subject that names the change. One concern per commit, and a body of at most about three short lines: a small commit is one a reviewer can read whole and revert alone.

## Prose

Never break a line inside a sentence, in Markdown, comments or commit messages. A line ends where a sentence or paragraph ends. oxfmt preserves line breaks in Markdown, so a hard-wrapped sentence stays wrapped.

## Fixtures

A test fixture is generated by code in this repository or is licence-clean, with its source and licence recorded next to it. A fixture of unknown origin cannot be redistributed under this repository's licences.
