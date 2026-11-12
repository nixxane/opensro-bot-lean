/*
setup.mjs - deploy the NIX live hub to your own Cloudflare account

  npm run setup               new code, deploy, print the links
  npm run setup -- --keep-code  deploy again with the code saved in .code (your paired bots keep working)

Needs "npx wrangler login" done once. It makes a fresh code (18 random bytes, base64url), deploys the Worker, stores the
code as the Worker secret LIVE_CODE and prints the dashboard link and the pair link. The code is saved in .code
(ignored by git); anyone with it can watch your stats, so keep it private. Rerunnable.
*/
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_FILE = path.join(HERE, '.code');
const WRANGLER = path.join(HERE, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const WORKER_URL = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i;

export const newCode = () => crypto.randomBytes(18).toString('base64url');
export const deployedUrl = output => (String(output).match(WORKER_URL) || [''])[0];
export const links = (url, code) => ({ dashboard: url + '/#' + code, pair: url + '/pair/' + code });

function readSavedCode() {
  try {
    const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
    return CODE_PATTERN.test(code) ? code : '';
  } catch { return ''; }
}

// Runs wrangler with this folder's pinned copy. The output is shown as it comes and also returned.
function wrangler(args, input) {
  const run = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: HERE, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const output = (run.stdout || '') + (run.stderr || '');
  process.stdout.write(output);
  if (run.status !== 0) {
    console.error('\nwrangler ' + args[0] + ' failed. If it asked you to log in, run "npm run login" first.');
    process.exit(run.status || 1);
  }
  return output;
}

function main() {
  if (!fs.existsSync(WRANGLER)) { console.error('Run "npm install" in this folder first.'); process.exit(1); }
  let code = '';
  if (process.argv.includes('--keep-code')) {
    code = readSavedCode();
    if (!code) console.log('No saved code in .code, making a new one.');
  }
  code = code || newCode();
  fs.writeFileSync(CODE_FILE, code + '\n', { mode: 0o600 });

  // Deploy first: setting a secret on a Worker that does not exist yet makes wrangler stop and ask.
  const url = deployedUrl(wrangler(['deploy']));
  wrangler(['secret', 'put', 'LIVE_CODE'], code + '\n');
  if (!url) {
    console.log('\nDeployed, but the address was not in wrangler\'s output. Find it in the Cloudflare dashboard under Workers, "nix-live", then:');
    console.log('  dashboard link: <address>/#' + code + '\n  pair link:      <address>/pair/' + code);
    return;
  }
  const made = links(url, code);
  console.log('\nNIX live is deployed.\n  Pair link (open it in the browser where the game runs): ' + made.pair + '\n  Dashboard link (open it on your phone):                 ' + made.dashboard);
  console.log('\nKeep both links private: the code in them lets anyone watch your stats. It is saved in .code.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
