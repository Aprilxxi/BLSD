import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error('Use Node.js 22.12 or later.');
console.log(`Node.js ${process.versions.node}`);
for (const relative of ['dist/client/index.html', 'server/index.mjs', 'server/api.mjs',
  'server/results-download.mjs', 'server/readable-results.mjs', 'server/results-workbook.mjs', 'server/analysis-downloads.mjs', 'server/job-lifecycle.mjs', 'server/async-tasks.mjs', 'server/task-results.mjs',
  'server/blsd_adapter.R', 'server/blsd_export.R',
  'src/ageGroups.js', 'src/bothGroups.js']) await access(path.join(root, relative));
const jobRoot = path.join(root, 'server', '.jobs');
await mkdir(jobRoot, { recursive: true });
const probe = path.join(jobRoot, `write-check-${randomUUID()}.tmp`);
await writeFile(probe, 'write-check');
await unlink(probe);
let rscript = process.env.BLSD_RSCRIPT;
if (!rscript && process.platform === 'win32') {
  const bases = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'R'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'R'),
    path.join(path.parse(root).root, 'Program Files', 'R')].filter(Boolean);
  outer: for (const base of bases) {
    let versions;
    try { versions = (await readdir(base)).sort().reverse(); } catch { continue; }
    for (const version of versions) for (const suffix of [['bin', 'Rscript.exe'], ['bin', 'x64', 'Rscript.exe']]) {
      const candidate = path.join(base, version, ...suffix);
      try { await access(candidate); rscript = candidate; break outer; } catch { /* next candidate */ }
    }
  }
}
rscript ||= 'Rscript';
console.log(`Rscript: ${rscript}`);
try {
  execFileSync(rscript, ['--vanilla', path.join(root, 'deployment', 'check-r.R')], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ...(process.platform === 'win32' ? { LC_ALL: 'English_United States.utf8' } : {}) },
  });
  console.log('Environment check passed. Check Chinese PDF, PNG and TIFF font rendering after installation.');
} catch {
  console.error('R check failed. Set BLSD_RSCRIPT to Rscript and install the required R packages.');
  process.exitCode = 1;
}
