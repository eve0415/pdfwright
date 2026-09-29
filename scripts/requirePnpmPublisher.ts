import { env, exit, stderr } from 'node:process';

const userAgent = env['npm_config_user_agent'];

if (userAgent === undefined || !/^pnpm\/\d/u.test(userAgent)) {
  stderr.write('Publish with pnpm.\n');
  exit(1);
}
