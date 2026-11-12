import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'deployment', 'start-windows.ps1');
const source = readFileSync(launcher, 'utf8');
const helpers = source.slice(source.indexOf('function Get-OwnedProcess('), source.indexOf('\ntry {\n    $sha'));
const options = { skip: process.platform !== 'win32' ? 'Windows PowerShell launcher checks' : false };
const quote = value => `'${value.replaceAll("'", "''")}'`;

function runFixture(t, scenario) {
  const directory = mkdtempSync(path.join(tmpdir(), 'blsd-stop-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'test.ps1');
  const program = `
$ErrorActionPreference='Stop'
${helpers}
$projectRoot=${quote(directory)}
$entry=Join-Path $projectRoot 'server\\index.mjs'
$Port=4175
$StopTimeoutSeconds=1
$stopRequestPath=Join-Path $projectRoot 'windows-4175.stop.json'
$created=[datetime]'2026-01-01T00:00:00Z'
$script:processes=@{}
$script:processes[901001]=[pscustomobject]@{ProcessId=901001;ParentProcessId=123;ExecutablePath='C:\\node.exe';CommandLine=('node.exe "'+$entry+'"');CreationDate=$created}
$script:processes[901002]=[pscustomobject]@{ProcessId=901002;ParentProcessId=901001;ExecutablePath='C:\\Rscript.exe';CommandLine='Rscript adapter.R request.json';CreationDate=$created.AddSeconds(1)}
$script:processes[901003]=[pscustomobject]@{ProcessId=901003;ParentProcessId=555;ExecutablePath='C:\\other.exe';CommandLine='unrelated';CreationDate=$created.AddSeconds(2)}
$script:stopped=@()
function Get-CimInstance { param($ClassName,$Filter)
  if ($Filter -match '^ProcessId=(\\d+)$') { return $script:processes[[int]$Matches[1]] }
  return @($script:processes.Values)
}
function Stop-Process { param($Id,$ErrorAction)
  $script:stopped += [int]$Id
  $script:processes.Remove([int]$Id)
}
function Start-Sleep { param($Milliseconds)
  if ($script:gracefulExit -and (Test-Path -LiteralPath $stopRequestPath)) {
    $script:processes.Remove(901002); $script:processes.Remove(901001)
  }
}
$record=[pscustomobject]@{projectRoot=$projectRoot;entry=$entry;port=4175;processId=901001;nodePath='C:\\node.exe';creationUtcTicks=[string]$created.ToUniversalTime().Ticks;stopToken='';stopFile=''}
${scenario}
`;
  writeFileSync(script, program);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('Windows launcher parses without executing or changing a service', options, () => {
  const command = `$errors=$null; $tokens=$null; [void][Management.Automation.Language.Parser]::ParseFile(${quote(launcher)},[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(helpers.startsWith('function Get-OwnedProcess('));
});

test('Windows website detection accepts current and legacy product titles with healthy API only', options, t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'blsd-title-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const detector = source.slice(source.indexOf('function Test-Website {'), source.indexOf('function Open-Website {'));
  assert.ok(detector.startsWith('function Test-Website {'));
  const script = path.join(directory, 'test.ps1');
  writeFileSync(script, `
$ErrorActionPreference='Stop'
$url='http://fixture.invalid/'
function Invoke-RestMethod { param($Uri,$TimeoutSec,[switch]$UseBasicParsing) return @{available=$script:available} }
function Invoke-WebRequest { param($Uri,$TimeoutSec,[switch]$UseBasicParsing) return @{Content=('<title>'+$script:title+'</title>')} }
${detector}
$checks=@()
foreach ($healthy in @($true,$false)) {
  $script:available=$healthy
  foreach ($name in @('BLSD Tool','BLSD Studio','Other application')) {
    $script:title=$name
    $checks += [pscustomobject]@{healthy=$healthy;title=$name;recognized=(Test-Website)}
  }
}
ConvertTo-Json -InputObject $checks -Compress
`);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const checks = JSON.parse(result.stdout.trim());
  assert.equal(checks.length, 6);
  for (const check of checks) assert.equal(check.recognized,
    check.healthy && ['BLSD Tool', 'BLSD Studio'].includes(check.title));
});

test('Windows stop gives the verified process a secret shutdown request before force', options, t => {
  const result = runFixture(t, `
$record.stopToken=('a'*64); $record.stopFile=$stopRequestPath; $script:gracefulExit=$true
Stop-OwnedService $record
[pscustomobject]@{stopped=@($script:stopped);unrelatedAlive=$script:processes.ContainsKey(901003);requestRemains=(Test-Path -LiteralPath $stopRequestPath)} | ConvertTo-Json -Compress
`);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.unrelatedAlive, true);
  assert.equal(result.requestRemains, false);
});

test('legacy Windows stop terminates only verified descendants before the root', options, t => {
  const result = runFixture(t, `
Stop-OwnedService $record
[pscustomobject]@{stopped=@($script:stopped);unrelatedAlive=$script:processes.ContainsKey(901003)} | ConvertTo-Json -Compress
`);
  assert.deepEqual(result.stopped, [901002, 901001]);
  assert.equal(result.unrelatedAlive, true);
});

test('Windows stop refuses a reused root PID and recognizes a reused child PID', options, t => {
  const result = runFixture(t, `
$child=Get-ProcessIdentity $script:processes[901002]
$script:processes[901002].CreationDate=$created.AddSeconds(10)
$childMatches=($null -ne (Get-MatchingProcess $child))
$script:processes[901001].CreationDate=$created.AddSeconds(20)
$refused=$false
try { Stop-OwnedService $record } catch { $refused=$true }
[pscustomobject]@{refused=$refused;childMatches=$childMatches;stopped=@($script:stopped);unrelatedAlive=$script:processes.ContainsKey(901003)} | ConvertTo-Json -Compress
`);
  assert.equal(result.refused, true);
  assert.equal(result.childMatches, false);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.unrelatedAlive, true);
});
