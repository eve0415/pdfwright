import { spawnSync } from 'node:child_process';
import { env, execPath } from 'node:process';

import { describe, expect, it } from 'vitest';

const publisher = new URL('requirePnpmPublisher.ts', import.meta.url);

const status = (userAgent: string | null): number | null => {
  const childEnv = { ...env };
  if (userAgent === null) delete childEnv['npm_config_user_agent'];
  else childEnv['npm_config_user_agent'] = userAgent;
  return spawnSync(execPath, [publisher.pathname], { env: childEnv }).status;
};

describe('package publisher guard', () => {
  it('accepts pnpm and refuses npm or an absent publisher', () => {
    expect([status('pnpm/12.6.0 npm/? node/v24'), status('npm/11.0.0 node/v24'), status(null)]).toStrictEqual([0, 1, 1]);
  });
});
