import { spawnSync } from 'node:child_process';
import { env, execPath } from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const publisher = new URL('requirePnpmPublisher.ts', import.meta.url);

interface Outcome {
  readonly status: number | null;
  readonly stderr: string;
}

const run = (userAgent: string | null): Outcome => {
  const childEnv = { ...env };
  if (userAgent === null) {
    delete childEnv['npm_config_user_agent'];
  } else {
    childEnv['npm_config_user_agent'] = userAgent;
  }
  const result = spawnSync(execPath, [publisher.pathname], { env: childEnv, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
};

// pnpm's user agent starts with its name and version, for example `pnpm/11.0.0 npm/? node/v26.13.1 linux x64`.
const isPnpm = (userAgent: string): boolean => {
  const versionStart = userAgent.charAt(5);
  return userAgent.startsWith('pnpm/') && versionStart.length === 1 && versionStart >= '0' && versionStart <= '9';
};

describe('package publisher guard', () => {
  it('accepts a user agent that starts with a pnpm version', () => {
    expect(run('pnpm/12.6.0 npm/? node/v24')).toStrictEqual({ status: 0, stderr: '' });
  });

  it.each([
    { case: 'npm', userAgent: 'npm/11.0.0 node/v24' },
    { case: 'pnpm after another publisher', userAgent: 'npm/11.0.0 node/v24 pnpm/12.0.0' },
    { case: 'pnpm without a version', userAgent: 'pnpm/ npm/?' },
    { case: 'an empty user agent', userAgent: '' },
    { case: 'no user agent', userAgent: null },
  ])('refuses $case and names pnpm', ({ userAgent }) => {
    const outcome = run(userAgent);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/pnpm/u);
  });

  describe('properties', () => {
    const fragment = fc.constantFrom('pnpm/', 'npm/', '1', 'x', ' ', '/', 'pnpm', '9.0');
    const userAgent = fc
      .tuple(fc.constantFrom('', 'pnpm/', 'npm/', ' pnpm/', 'pnpm'), fc.constantFrom('', '1', '9.0', 'x', ' '), fc.array(fragment, { maxLength: 3 }))
      .map(([start, version, rest]) => [start, version, ...rest].join(''));

    it('exits 0 exactly when the user agent starts with pnpm and a version digit', () => {
      fc.assert(
        fc.property(userAgent, value => {
          expect(run(value).status).toBe(isPnpm(value) ? 0 : 1);
        }),
      );
    });
  });
});
