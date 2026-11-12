import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const TOKEN = /^[a-f0-9]{64}$/;
const JOB = /^blsd-[A-Za-z0-9]{6}$/;
const MARKER = '.blsd-owner.json';
const DAY = 24 * 60 * 60 * 1000;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// OS creation identities distinguish a dead owner from an unrelated reused PID.
export async function inspectProcess(pid, { platform = process.platform, readFile: readProcessFile = readFile } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); [string]$p.StartTime.ToUniversalTime().Ticks } catch [ArgumentException] { 'DEAD' }`],
      { windowsHide: true, timeout: 15000, maxBuffer: 8192 });
      const key = stdout.trim();
      if (key === 'DEAD') return { state: 'dead' };
      return /^\d+$/.test(key) ? { state: 'alive', startKey: `windows:${key}` } : { state: 'unknown' };
    }
    if (platform === 'linux') {
      let stat;
      try { stat = await readProcessFile(`/proc/${pid}/stat`, 'utf8'); }
      catch (error) { return { state: error.code === 'ENOENT' ? 'dead' : 'unknown' }; }
      // boot_id is system identity, not evidence that this PID has ended.
      // Missing or restricted /proc/sys must never authorize job recovery.
      const boot = (await readProcessFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const header = /^(\d+) \([\s\S]*\) /.exec(stat);
      if (!header || Number(header[1]) !== pid || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(boot))
        return { state: 'unknown' };
      const fields = stat.slice(header[0].length).trim().split(/\s+/);
      return /^[RSDZTWtXxKWPIN]$/.test(fields[0] ?? '') && fields.length >= 20 &&
          fields.slice(1).every(value => /^-?\d+$/.test(value)) && /^\d+$/.test(fields[19] ?? '')
        ? { state: 'alive', startKey: `linux:${boot.toLowerCase()}:${fields[19]}` } : { state: 'unknown' };
    }
  } catch { /* Unavailable system identity and malformed proc data stay unknown. */ }
  return { state: 'unknown' };
}

// An orphan R child can outlive Node. Defer recovery whenever R is active.
// Legacy, unmarked jobs additionally require no other instance of this project.
export async function recoverySafetyCheck(jobRoot) {
  try {
    let processes;
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|Rscript|Rterm|R)\\.exe$' } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress"],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(stdout || '[]');
      processes = (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: p.ProcessId, name: p.Name, command: p.CommandLine }));
    } else if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm=,args='], { timeout: 15000, maxBuffer: 1024 * 1024 });
      processes = stdout.trim().split('\n').map(line => {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        return match && { pid: Number(match[1]), name: match[2], command: match[3] };
      }).filter(Boolean);
    } else return { safeToRecover: false, legacyIdle: false };
    if (processes.some(p => /^(Rscript|Rterm|R)(\.exe)?$/i.test(p.name))) return { safeToRecover: false, legacyIdle: false };
    const project = path.resolve(jobRoot, '..', '..').replaceAll('\\', '/').toLowerCase();
    const otherInstance = processes.some(p => p.pid !== process.pid && /^node(\.exe)?$/i.test(p.name) &&
      (!p.command || p.command.replaceAll('\\', '/').toLowerCase().includes(project) || /(?:^|[\s"/])server\/index\.mjs(?:[\s"]|$)/i.test(p.command.replaceAll('\\', '/'))));
    return { safeToRecover: true, legacyIdle: !otherInstance };
  } catch { return { safeToRecover: false, legacyIdle: false }; }
}

async function readPlainJson(file, maxBytes = 16384) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Not a plain metadata file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, '')); } finally { await handle.close(); }
}
function validOwner(owner) {
  return owner?.version === 1 && TOKEN.test(owner.token ?? '') && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.startKey === 'string' && owner.startKey.length > 0 && owner.startKey.length < 256 &&
    typeof owner.verified === 'boolean' && Number.isFinite(owner.createdAt);
}
function matchingOwners(a, b) {
  return validOwner(a) && validOwner(b) && a.token === b.token && a.pid === b.pid && a.startKey === b.startKey &&
    a.verified === b.verified && a.createdAt === b.createdAt;
}
async function plainTree(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name), stat = await lstat(child);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return false;
    if (stat.isDirectory() && !(await plainTree(child))) return false;
  }
  return true;
}
async function recognizableLegacy(directory, cutoff) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || Math.max(info.mtimeMs, info.birthtimeMs) > cutoff) return false;
  const entries = await readdir(directory);
  if (entries.length !== 3 || !['request.json', 'response.json', 'fit.rds'].every(name => entries.includes(name))) return false;
  const [request, response, model] = await Promise.all([readPlainJson(path.join(directory, 'request.json'), 64 * 1024 * 1024),
    readPlainJson(path.join(directory, 'response.json'), 64 * 1024 * 1024), lstat(path.join(directory, 'fit.rds'))]);
  const row = request.rows?.[0], point = response.points?.[0];
  if (!Array.isArray(request.rows) || !row || !Number.isFinite(row.Year) || !Number.isFinite(row.Age_Mid) ||
      !Number.isFinite(row.Pop) || row.Pop <= 0 || !Number.isFinite(row.Deaths ?? row.Count) ||
      response.schemaVersion !== '1' || response.meta?.fitted !== true || response.meta?.statisticalFitExecuted !== true ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(response.fitId ?? '') || response.meta.fitId !== response.fitId ||
      !Array.isArray(response.points) || !point || !Number.isFinite(point.year) || !Number.isFinite(point.age) ||
      !model.isFile() || model.isSymbolicLink() || model.mtimeMs > cutoff) return false;
  const handle = await open(path.join(directory, 'fit.rds'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(3); await handle.read(header, 0, 3, 0);
    return header[0] === 0x1f && header[1] === 0x8b && header[2] === 8;
  } finally { await handle.close(); }
}

export function createJobLifecycle({ jobRoot, legacyMaxAgeMs = DAY, processInspector = inspectProcess,
  safetyCheck = recoverySafetyCheck, now = Date.now } = {}) {
  if (!jobRoot) throw new Error('A job directory is required.');
  const root = path.resolve(jobRoot), owned = new Set();
  const token = randomBytes(32).toString('hex'), lock = path.join(root, `.owner-${token}.json`);
  let initialization, owner, closed = false;
  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(root), root)) throw new Error('The job root must be a real directory.');
    let identity;
    try { identity = await processInspector(process.pid); } catch { identity = { state: 'unknown' }; }
    const verified = identity.state === 'alive' && typeof identity.startKey === 'string' && Boolean(identity.startKey);
    owner = { version: 1, token, pid: process.pid, startKey: verified ? identity.startKey : `unverified:${token}`, verified, createdAt: now() };
    await writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    const safety = await safetyCheck(root);
    if (!safety.safeToRecover) return;
    const inspected = new Map();
    async function inactive(previousOwner) {
      if (!inspected.has(previousOwner.pid)) inspected.set(previousOwner.pid, await processInspector(previousOwner.pid));
      const previous = inspected.get(previousOwner.pid);
      return previous.state === 'dead' || (previousOwner.verified && previous.state === 'alive' && previous.startKey !== previousOwner.startKey);
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!JOB.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(root, entry.name);
      try {
        let marker;
        try { marker = await readPlainJson(path.join(directory, MARKER)); }
        catch (error) {
          if (error.code !== 'ENOENT' || !safety.legacyIdle || !(await recognizableLegacy(directory, now() - Math.max(DAY, legacyMaxAgeMs)))) continue;
          if (await plainTree(directory)) await rm(directory, { recursive: true });
          continue;
        }
        if (!validOwner(marker)) continue;
        const previousLock = path.join(root, `.owner-${marker.token}.json`);
        if (!matchingOwners(marker, await readPlainJson(previousLock))) continue;
        if (!(await inactive(marker))) continue;
        if (await plainTree(directory)) await rm(directory, { recursive: true });
      } catch { /* Uncertain ownership, permissions or a changed tree: preserve it. */ }
    }
    // Only remove a dead owner's lock after no remaining job references it.
    // An unreadable/changed marker or linked job keeps all old locks intact.
    const referenced = new Set();
    let uncertain = false;
    const remaining = await readdir(root, { withFileTypes: true });
    for (const entry of remaining) {
      if (!JOB.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { uncertain = true; continue; }
      try {
        const marker = await readPlainJson(path.join(root, entry.name, MARKER));
        if (validOwner(marker)) referenced.add(marker.token); else uncertain = true;
      } catch (error) { if (error.code !== 'ENOENT') uncertain = true; }
    }
    if (!uncertain) for (const entry of remaining) {
      const match = /^\.owner-([a-f0-9]{64})\.json$/.exec(entry.name);
      if (!match || match[1] === token || referenced.has(match[1]) || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const file = path.join(root, entry.name), previous = await readPlainJson(file);
        if (validOwner(previous) && previous.token === match[1] && await inactive(previous)) await unlink(file);
      } catch { /* Unknown owners remain untouched. */ }
    }
  }
  const ready = () => initialization ??= initialize();
  async function removeJob(directory) {
    const resolved = path.resolve(directory);
    if (!owned.has(resolved) || !samePath(path.dirname(resolved), root) || !JOB.test(path.basename(resolved)))
      throw new Error('Refusing to remove an unowned job directory.');
    try {
      if (!matchingOwners(owner, await readPlainJson(path.join(resolved, MARKER))) ||
          !matchingOwners(owner, await readPlainJson(lock)) || !(await plainTree(resolved)))
        throw new Error('Refusing to remove a job with changed ownership or symbolic links.');
      await rm(resolved, { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await lstat(resolved); } catch (missing) { if (missing.code === 'ENOENT') { owned.delete(resolved); return; } throw missing; }
      throw error;
    }
    owned.delete(resolved);
  }
  return {
    hasJob: directory => owned.has(path.resolve(directory)),
    async newJob() {
      if (closed) throw new Error('The analysis service is closing.');
      await ready();
      if (closed) throw new Error('The analysis service is closing.');
      const directory = await mkdtemp(path.join(root, 'blsd-'));
      owned.add(directory);
      try { await writeFile(path.join(directory, MARKER), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        try { if (await plainTree(directory)) { await rm(directory, { recursive: true }); owned.delete(directory); } } catch { /* Retain ownership for close(). */ }
        throw error;
      }
      return directory;
    },
    removeJob,
    async close() {
      closed = true;
      if (!initialization) return;
      await initialization;
      const errors = [];
      for (const directory of [...owned]) try { await removeJob(directory); } catch (error) { errors.push(error); }
      if (!owned.size && matchingOwners(owner, await readPlainJson(lock))) await unlink(lock);
      if (errors.length) throw new AggregateError(errors, 'Some analysis jobs could not be safely removed.');
    },
  };
}

// Windows launchers use a per-launch secret and a fixed local file, avoiding a
// public shutdown endpoint. The caller closes its HTTP server gracefully.
export function watchLauncherStop(callback, { root = path.resolve(import.meta.dirname, '..'), env = process.env, intervalMs = 500 } = {}) {
  const token = env.BLSD_LAUNCHER_STOP_TOKEN, file = env.BLSD_LAUNCHER_STOP_FILE;
  if (!TOKEN.test(token ?? '') || !file) return () => {};
  const directory = path.join(root, 'server', '.launcher'), resolved = path.resolve(file);
  if (!samePath(path.dirname(resolved), directory) || !/^windows-\d+\.stop\.json$/.test(path.basename(resolved))) return () => {};
  let checking = false, stopped = false;
  const timer = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const request = await readPlainJson(resolved);
      if (request.token === token && request.processId === process.pid) {
        stopped = true; clearInterval(timer);
        await unlink(resolved);
        callback();
      }
    } catch { /* A partial, absent or untrusted request cannot stop the server. */ }
    finally { checking = false; }
  }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
