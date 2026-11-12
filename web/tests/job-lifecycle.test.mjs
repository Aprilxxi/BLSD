import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { createJobLifecycle, inspectProcess, watchLauncherStop } from '../server/job-lifecycle.mjs';

const DAY = 86400000;
const oldOwner = { version: 1, token: 'a'.repeat(64), pid: 444444, startKey: 'old-start', verified: true, createdAt: 1 };
const bootId = '01234567-89ab-cdef-0123-456789abcdef';
function linuxStat(pid, start = '12345') {
  const fields = Array(50).fill('0'); fields[0] = 'S'; fields[19] = start;
  return `${pid} (node worker) ${fields.join(' ')}\n`;
}
function linuxInspector({ stat, statError, boot = bootId, bootError } = {}) {
  return pid => inspectProcess(pid, { platform: 'linux', readFile: async file => {
    if (file === `/proc/${pid}/stat`) {
      if (statError) throw Object.assign(new Error('Process stat unavailable'), { code: statError });
      return stat ?? linuxStat(pid);
    }
    assert.equal(file, '/proc/sys/kernel/random/boot_id');
    if (bootError) throw Object.assign(new Error('Boot identity unavailable'), { code: bootError });
    return boot;
  } });
}
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blsd-jobs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function lifecycle(root, overrides = {}) {
  return createJobLifecycle({ jobRoot: root,
    processInspector: async pid => pid === process.pid ? { state: 'alive', startKey: 'current-start' } : { state: 'dead' },
    safetyCheck: async () => ({ safeToRecover: true, legacyIdle: true }), ...overrides });
}
async function markedJob(root, name, owner = oldOwner, lockOwner = owner) {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, '.blsd-owner.json'), JSON.stringify(owner));
  await writeFile(path.join(root, `.owner-${owner.token}.json`), JSON.stringify(lockOwner));
  await writeFile(path.join(directory, 'retained.rds'), 'retained-model');
  return directory;
}

test('OS identity identifies the current process without relying on PID alone', async () => {
  const identity = await inspectProcess(process.pid);
  assert.equal(identity.state, 'alive');
  assert.ok(identity.startKey);
  assert.deepEqual(await inspectProcess(-1), { state: 'unknown' });
});

test('Linux classifies only a missing PID stat as dead; unavailable boot identity remains unknown', async () => {
  assert.deepEqual(await linuxInspector({ statError: 'ENOENT' })(444444), { state: 'dead' });
  for (const options of [{ statError: 'EACCES' }, { bootError: 'ENOENT' }, { bootError: 'EACCES' },
    { boot: '' }, { boot: 'invalid-boot-id' }])
    assert.deepEqual(await linuxInspector(options)(444444), { state: 'unknown' }, JSON.stringify(options));
  assert.deepEqual(await linuxInspector()(444444), { state: 'alive', startKey: `linux:${bootId}:12345` });
});

test('Linux malformed process stat never produces an alive or dead identity', async () => {
  for (const stat of ['', 'unreadable stat', linuxStat(123), '444444 (node) S 0 0',
    linuxStat(444444, '-1'), linuxStat(444444, 'invalid'), linuxStat(444444).replace(') S ', ') ? ')])
    assert.deepEqual(await linuxInspector({ stat })(444444), { state: 'unknown' }, stat);
});

test('Linux exact or unavailable boot identity preserves a live owner while a new PID generation permits recovery', async t => {
  const owner = { ...oldOwner, startKey: `linux:${bootId}:12345` };
  for (const bootError of [undefined, 'ENOENT', 'EACCES']) {
    const root = await fixture(t), active = await markedJob(root, 'blsd-abcdef', owner);
    const service = lifecycle(root, { processInspector: linuxInspector({ bootError }) });
    await service.newJob();
    assert.equal(await exists(active), true, `${bootError ?? 'A matching identity'} must preserve the existing owner's files.`);
    await service.close();
    assert.equal(await exists(active), true);
  }
  const root = await fixture(t), reused = await markedJob(root, 'blsd-abcdef', owner);
  const service = lifecycle(root, { processInspector: linuxInspector({ stat: linuxStat(owner.pid, '67890') }) });
  await service.newJob();
  assert.equal(await exists(reused), false, 'A readable, different creation identity still permits recovery.');
  await service.close();
});

test('recover a proven dead owner and remove only this lifecycle jobs on close', async t => {
  const root = await fixture(t), stale = await markedJob(root, 'blsd-abcdef');
  const service = lifecycle(root), own = await service.newJob();
  assert.equal(await exists(stale), false);
  assert.equal(await exists(path.join(root, `.owner-${oldOwner.token}.json`)), false);
  assert.equal(service.hasJob(own), true);
  const marker = JSON.parse(await readFile(path.join(own, '.blsd-owner.json')));
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.startKey, 'current-start');
  await service.close();
  assert.equal(await exists(own), false);
});

test('preserve active owners, unknown identities and inconsistent ownership locks', async t => {
  for (const status of [{ state: 'alive', startKey: 'old-start' }, { state: 'unknown' }]) {
    const root = await fixture(t), protectedJob = await markedJob(root, 'blsd-abcdef');
    const service = lifecycle(root, { processInspector: async pid => pid === process.pid ? { state: 'alive', startKey: 'current-start' } : status });
    await service.newJob();
    assert.equal(await exists(protectedJob), true);
    await service.close();
    assert.equal(await exists(protectedJob), true);
  }
  const root = await fixture(t), mismatched = await markedJob(root, 'blsd-abcdef', oldOwner, { ...oldOwner, startKey: 'different' });
  const service = lifecycle(root); await service.newJob();
  assert.equal(await exists(mismatched), true); await service.close();
});

test('PID reuse permits recovery only when the exact OS creation identity differs', async t => {
  const root = await fixture(t), stale = await markedJob(root, 'blsd-abcdef');
  const service = lifecycle(root, { processInspector: async pid => ({ state: 'alive', startKey: pid === process.pid ? 'current-start' : 'different-start' }) });
  await service.newJob(); assert.equal(await exists(stale), false); await service.close();
});

test('active R or failed process enumeration defers recovery', async t => {
  const root = await fixture(t), stale = await markedJob(root, 'blsd-abcdef');
  const service = lifecycle(root, { safetyCheck: async () => ({ safeToRecover: false, legacyIdle: false }) });
  await service.newJob(); assert.equal(await exists(stale), true); await service.close();
});

test('a restricted OS identity query does not prevent new analysis jobs or authorize live-owner deletion', async t => {
  const root = await fixture(t), protectedJob = await markedJob(root, 'blsd-abcdef', { ...oldOwner, verified: false, startKey: 'unverified:old' });
  const service = lifecycle(root, { processInspector: async pid => pid === process.pid ? { state: 'unknown' } : { state: 'alive', startKey: 'different' } });
  const own = await service.newJob();
  assert.equal(await exists(protectedJob), true);
  const marker = JSON.parse(await readFile(path.join(own, '.blsd-owner.json')));
  assert.equal(marker.verified, false);
  await service.close(); assert.equal(await exists(own), false);
});

test('unrecognized directories and symlinks are never reclaimed', async t => {
  const root = await fixture(t), outside = await fixture(t), target = path.join(outside, 'keep.txt');
  await writeFile(target, 'keep');
  const directory = await markedJob(root, 'blsd-abcdef');
  await symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, path.join(root, 'blsd-ghijkl'), process.platform === 'win32' ? 'junction' : 'dir');
  const unknown = path.join(root, 'blsd-123456'); await mkdir(unknown); await writeFile(path.join(unknown, 'unrelated.txt'), 'keep');
  const service = lifecycle(root); await service.newJob();
  assert.equal(await exists(directory), true); assert.equal(await exists(unknown), true);
  assert.equal(await readFile(target, 'utf8'), 'keep'); await service.close();
});

test('legacy jobs need recognizable files, 24 hours of age and no other project instance', async t => {
  const root = await fixture(t), directory = path.join(root, 'blsd-abcdef'); await mkdir(directory);
  const fitId = '12345678-1234-1234-1234-123456789abc';
  await writeFile(path.join(directory, 'request.json'), JSON.stringify({ rows: [{ Year: 2000, Age_Mid: 32.5, Count: 1, Pop: 1000 }] }));
  await writeFile(path.join(directory, 'response.json'), JSON.stringify({ schemaVersion: '1', fitId, meta: { fitted: true, statisticalFitExecuted: true, fitId }, points: [{ year: 2000, age: 32.5 }] }));
  await writeFile(path.join(directory, 'fit.rds'), Buffer.from([31, 139, 8, 0]));
  const old = new Date(Date.now() - 2 * DAY);
  for (const name of await readdir(directory)) await utimes(path.join(directory, name), old, old);
  await utimes(directory, old, old);
  // An advanced test clock also covers creation time, which cannot be backdated.
  const clock = () => Date.now() + 2 * DAY;
  const busy = lifecycle(root, { now: clock, safetyCheck: async () => ({ safeToRecover: true, legacyIdle: false }) });
  await busy.newJob(); assert.equal(await exists(directory), true); await busy.close();
  const service = lifecycle(root, { now: clock });
  await service.newJob(); assert.equal(await exists(directory), false); await service.close();
});

test('normal cleanup refuses foreign, altered or linked jobs', async t => {
  const root = await fixture(t), service = lifecycle(root), own = await service.newJob();
  await assert.rejects(service.removeJob(path.join(root, 'blsd-unknown')), /unowned/);
  await writeFile(path.join(own, '.blsd-owner.json'), JSON.stringify(oldOwner));
  await assert.rejects(service.removeJob(own), /ownership/);
  assert.equal(await exists(own), true);
  const removable = await service.newJob();
  await assert.rejects(service.close(), /could not be safely removed/);
  assert.equal(await exists(own), true);
  assert.equal(await exists(removable), false);
});

test('launcher stop requires the exact per-launch secret and PID, and accepts PowerShell UTF-8 BOM', async t => {
  const root = await fixture(t), directory = path.join(root, 'server', '.launcher'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'windows-4175.stop.json'), token = 'c'.repeat(64);
  let stops = 0;
  const stopWatching = watchLauncherStop(() => { stops += 1; }, { root, intervalMs: 10, env: { BLSD_LAUNCHER_STOP_TOKEN: token, BLSD_LAUNCHER_STOP_FILE: file } });
  t.after(stopWatching);
  await writeFile(file, JSON.stringify({ token: 'd'.repeat(64), processId: process.pid }));
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(stops, 0);
  await writeFile(file, JSON.stringify({ token, processId: process.pid + 1 }));
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(stops, 0);
  await writeFile(file, '\uFEFF' + JSON.stringify({ token, processId: process.pid }));
  for (let n = 0; n < 30 && stops === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stops, 1); assert.equal(await exists(file), false);
});
