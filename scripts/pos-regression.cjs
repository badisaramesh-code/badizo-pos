const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// A change can affect several workflows. Unmapped executable code runs every test.
const workflows = [
  [/bill|checkout|payment|return|customer|loyalty|invoice|sale/i, /bill|checkout|payment|money|posOperations|productLookup|ledger|counterClosing|report|sale/i],
  [/inward|purchase|stock|inventory|product|supplier|import|batch|wholesale|price/i, /inward|product|workbook|posOperations|payment|checkout|bill|orders/i],
  [/counterclosing|cashledger|books|ledger|localaccounts|accountingvoucher/i, /closing|books?|ledger|accounts|report|posOperations|payment/i],
  [/barcode|print|thermal|label/i, /print|barcode|label|orders/i],
  [/report|approval/i, /report|approval|books/i],
  [/orders|quotation|estimate|gatepass|payroll/i, /orders|productLookup|money|shopWorkspaces/i],
  [/customer|loyalty|voucher|supplier|user/i, /customerVoucherUsers|voucherMysql/i],
  [/backup|restore|cloudsync/i, /backup|restore|cloudsync|posOperations|runtimePolicy/i],
  [/auth|user|session/i, /login|auth|user|posOperations|session/i],
];

function discover(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = dir + '/' + entry.name;
    if (entry.isDirectory()) return discover(file);
    return /\.test\.(?:c?js|jsx)$/.test(file) ? [file] : [];
  });
}

function select(files, tests) {
  const chosen = new Set();
  for (const file of files) {
    if (/\.md$/i.test(file)) continue;
    if (tests.includes(file)) chosen.add(file);
    if (!/^(backend\/(routes|services|tests)|frontend\/src\/(components|utils)|scripts)\//.test(file)) return tests;
    const name = path.posix.basename(file);
    const rules = workflows.filter(([pattern]) => pattern.test(name));
    if (!rules.length) return tests;
    for (const [, match] of rules) {
      const matches = tests.filter(test => match.test(path.posix.basename(test)));
      if (!matches.length) return tests;
      matches.forEach(test => chosen.add(test));
    }
  }
  // New suites remain in every code-change run until their scope is classified.
  if (chosen.size) {
    tests.filter(test => !workflows.some(([, pattern]) => pattern.test(path.posix.basename(test))))
      .forEach(test => chosen.add(test));
  }
  return [...chosen].sort();
}

function changedFiles(base) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (base) {
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Expected a full base commit SHA');
    return git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--']);
  }
  return [...git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'])];
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: path.join(root, cwd), stdio: 'inherit', env: { ...process.env, CI: 'true' },
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  const desktopTests = fs.readdirSync(path.join(root, 'scripts'))
    .filter(name => /^test-.*\.cjs$/.test(name)).map(name => 'scripts/' + name);
  const tests = [...['backend/tests', 'frontend/src', 'scripts/tests'].flatMap(discover), ...desktopTests].sort();
  const baseIndex = args.indexOf('--base');
  if (baseIndex >= 0 && !args[baseIndex + 1]) throw new Error('Missing --base commit SHA');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
  const selected = args.includes('--all') ? tests : select(changedFiles(base), tests);
  console.log('Selected ' + selected.length + ' of ' + tests.length + ' test files');
  console.log(selected.join('\n'));
  if (args.includes('--list')) return;
  let passed = true;
  for (const dir of ['scripts', 'backend', 'frontend']) {
    const suite = selected.filter(file => file.startsWith(dir + '/')).map(file => path.join(root, file));
    if (!suite.length) continue;
    const options = dir === 'frontend'
      ? ['node_modules/react-scripts/bin/react-scripts.js', 'test', '--watchAll=false', '--runInBand', '--testMatch', '**/src/**/*.test.{js,jsx}', '--runTestsByPath']
      : ['--test'];
    if (!run(dir, [...options, ...suite])) passed = false;
  }
  if (!passed) process.exitCode = 1;
}
module.exports = { select };
if (require.main === module) main();
