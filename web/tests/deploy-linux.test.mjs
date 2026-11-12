import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'deployment', 'deploy-linux.sh');
const candidates = [process.env.BLSD_TEST_SHELL,
  ...(process.platform === 'win32'
    ? [path.resolve(path.dirname(process.execPath), '..', '..', 'native', 'git', 'usr', 'bin', 'sh.exe')]
    : ['/bin/bash', '/usr/bin/bash']),
].filter(Boolean);
const shell = candidates.find(existsSync);
const probe = shell && spawnSync(shell, ['--version'], { encoding: 'utf8', windowsHide: true });
const available = Boolean(shell && probe.status === 0 && /GNU bash/.test(probe.stdout));
if (process.env.BLSD_TEST_SHELL) assert.ok(available, 'BLSD_TEST_SHELL must name an executable Bash runtime.');
const options = { skip: available ? false : 'Bash runtime unavailable in this sandbox; set BLSD_TEST_SHELL to run installer checks.' };

function run(args, entry = script) {
  // The bundled Git runtime does not prepend /usr/bin by itself. Linux Bash also
  // accepts this PATH. No installer invocation in these tests mutates the host.
  return spawnSync(shell, ['-c', 'export PATH="/usr/bin:$PATH"; exec "$0" "$@"', shell, entry, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
}

test('Linux installer passes Bash syntax validation', options, () => {
  const result = spawnSync(shell, ['-n', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(script, 'utf8'), /^MARKER='Managed by BLSD Studio deploy-linux\.sh'$/m,
    'Product naming must preserve the management marker for existing installations.');
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /BLSD Tool automatic deployment/);
});

test('Linux installer dry runs HTTP, HTTPS and managed-update plans without root', options, () => {
  for (const args of [
    ['--domain', 'analysis.example.org'],
    ['--domain', '192.0.2.10'],
    ['--domain', 'ANALYSIS.example.org', '--update'],
    ['--domain', 'analysis.example.org', '--https', '--email', 'admin@example.org', '--agree-tos'],
  ]) {
    const result = run([...args, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No commands were executed that change the system/);
    assert.match(result.stdout, /\/opt\/blsd-studio/);
    assert.match(result.stdout, /127\.0\.0\.1:4174/);
  }
});

test('Linux installer rejects unsafe hosts and incomplete certificate consent before deployment', options, () => {
  for (const args of [
    [], ['--domain'], ['--unknown'],
    ['--domain', 'https://example.org/path'],
    ['--domain', 'example.org;touch /tmp/blsd-invalid'],
    ['--domain', '*.example.org'], ['--domain', 'example..org'],
    ['--domain', '-bad.example.org'], ['--domain', 'bad-.example.org'],
    ['--domain', '999.0.2.1'], ['--domain', '192.00.2.1'],
    ['--domain', 'analysis.example.org', '--https', '--email', 'admin@example.org'],
    ['--domain', 'analysis.example.org', '--https', '--agree-tos'],
    ['--domain', 'analysis.example.org', '--https', '--email', 'admin@example.org --bad', '--agree-tos'],
    ['--domain', '192.0.2.10', '--https', '--email', 'admin@example.org', '--agree-tos'],
    ['--domain', 'analysis.example.org', '--agree-tos'],
    ['--domain', 'analysis.example.org', '--email', 'admin@example.org'],
  ]) {
    const result = run([...args, '--dry-run']);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /ERROR:/, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /Deployment complete/);
  }
});

test('Linux installer refuses a bundle lacking its prebuilt runtime', options, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'blsd-installer-check-'));
  try {
    const copied = path.join(directory, 'deploy-linux.sh');
    copyFileSync(script, copied);
    const result = run(['--domain', 'analysis.example.org', '--dry-run'], copied);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incomplete bundle:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed post-issuance health check retains certificate ownership for a same-host retry', options, () => {
  const source = readFileSync(script, 'utf8');
  const ownershipCheck = source.match(/^certificate_belongs_to_domain\(\) \{[\s\S]*?^\}/m)?.[0];
  const issuanceBlock = source.match(/^if \(\(HTTPS\)\); then\n  log 'Requesting HTTPS[\s\S]*?^fi/m)?.[0];
  assert.ok(ownershipCheck && issuanceBlock, 'Locate the actual installer certificate operations.');
  const directory = mkdtempSync(path.join(tmpdir(), 'blsd-certificate-retry-'));
  const statePath = directory.replaceAll('\\', '/');
  const invoke = (code, ...args) => spawnSync(shell, ['-c', `export PATH="/usr/bin:$PATH"; ${code}`,
    'blsd-certificate-test', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  try {
    writeFileSync(path.join(directory, 'apt-get'), '#!/usr/bin/sh\nexit 0\n', { mode: 0o755 });
    // Execute the installer's real HTTPS block in isolation. System commands
    // are harmless functions; only its state files are written to this fixture.
    // Issuance succeeds, then health fails before the final deployment commit.
    const failedAttempt = invoke(`set -e
STATE=$(cd -- "$1" && pwd -P); DOMAIN=$2; EMAIL=admin@example.org; CERT_NAME=blsd-studio; HTTPS=1; SITE_CHANGED=0
export PATH="$STATE:/usr/bin:$PATH"
log() { :; }
install() { :; }
chmod() { :; }
certbot() { printf '%s\\n' "$*" > "$STATE/issued-test"; }
nginx() { :; }
systemctl() { :; }
check_health() { return 42; }
${issuanceBlock}`, statePath, 'analysis.example.org');
    assert.equal(failedAttempt.status, 42, failedAttempt.stderr);
    assert.match(readFileSync(path.join(directory, 'issued-test'), 'utf8'), /--cert-name blsd-studio/);
    assert.equal(existsSync(path.join(directory, 'domain')), false, 'No successful deployment marker exists.');
    assert.equal(readFileSync(path.join(directory, 'certificate-domain'), 'utf8'), 'analysis.example.org\n');
    const retry = invoke(`${ownershipCheck}\ncertificate_belongs_to_domain "$1" "$2"`, statePath, 'analysis.example.org');
    assert.equal(retry.status, 0, retry.stderr);
    const wrongHost = invoke(`${ownershipCheck}\ncertificate_belongs_to_domain "$1" "$2"`, statePath, 'other.example.org');
    assert.notEqual(wrongHost.status, 0, 'The retained certificate must not be adopted by another hostname.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime staging preserves Linux maintenance files and release documents', options, () => {
  const source = readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('install -d -m 755 -- "$STAGE/dist"');
  const end = source.indexOf('printf \'%s\\n\' "$MARKER" > "$STAGE/.blsd-managed-install"', start);
  assert.ok(start >= 0 && end > start, 'Locate the actual runtime staging copy operations.');
  const staging = source.slice(start, end);
  const runtime = [
    'package.json', 'dist/client/index.html', 'dist/client/assets/example.js',
    ...['index.mjs', 'api.mjs', 'results-download.mjs', 'readable-results.mjs',
      'results-workbook.mjs', 'analysis-downloads.mjs', 'job-lifecycle.mjs',
      'async-tasks.mjs', 'task-results.mjs', 'blsd_adapter.R', 'blsd_export.R'].map(name => `server/${name}`),
    'src/ageGroups.js', 'src/bothGroups.js',
    ...['deploy-linux.sh', 'start-linux.sh', 'check-environment.mjs', 'check-r.R',
      'install-r-packages.R', 'fonts.conf.example', 'blsd.service.example',
      'nginx.conf.example'].map(name => `deployment/${name}`),
  ];
  const documents = ['THIRD_PARTY_NOTICES.txt', 'RELEASE_MANIFEST.json', 'DEPLOYMENT_LINUX_zh.txt'];
  const directory = mkdtempSync(path.join(tmpdir(), 'blsd-staging-check-'));
  try {
    for (const includeDocuments of [true, false]) {
      const fixture = path.join(directory, includeDocuments ? 'release' : 'development');
      const stage = path.join(fixture, 'stage');
      const input = path.join(fixture, 'input');
      const expected = includeDocuments ? [...runtime, ...documents] : runtime;
      mkdirSync(stage, { recursive: true });
      for (const name of [...expected, 'unrelated-research.txt']) {
        const file = path.join(input, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `fixture ${name}\n`);
      }
      // Run only the installer's real local copy operations, never apt/systemd,
      // font installation, ownership changes, or service lifecycle operations.
      const result = spawnSync(shell, ['-c', `set -eu
export PATH="/usr/bin:$PATH"
SOURCE=$(cd -- "$1" && pwd -P)
STAGE=$(cd -- "$2" && pwd -P)
# The small Windows Git shell omits coreutils install. Its two used forms
# are file/directory copies here; real Linux executes its native install.
if ! command -v install >/dev/null; then
  install() {
    if [[ "$1" == -d ]]; then
      shift 4
      mkdir -p -- "$@"
    else
      shift 3
      cp -- "$@"
    fi
  }
fi
${staging}`, 'blsd-staging-test', input.replaceAll('\\', '/'), stage.replaceAll('\\', '/')],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
      for (const name of expected) assert.equal(readFileSync(path.join(stage, name), 'utf8'), `fixture ${name}\n`);
      for (const name of includeDocuments ? [] : documents) assert.equal(existsSync(path.join(stage, name)), false);
      assert.equal(existsSync(path.join(stage, 'unrelated-research.txt')), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
