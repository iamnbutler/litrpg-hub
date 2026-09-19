import { spawnSync } from 'node:child_process';

// Publish only reader OAuth credentials, never the offline catalog/API keys in .env.
const names = ['OAUTH_GITHUB_CLIENT_ID', 'OAUTH_GITHUB_CLIENT_SECRET'];
const secrets = Object.fromEntries(names.map((name) => {
  if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
  return [name, process.env[name]];
}));
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk', '--env='], {
  input: JSON.stringify(secrets), encoding: 'utf8'
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
