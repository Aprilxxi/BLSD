// Import the approved observations exactly; never generate counts or fit models.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseAgeGroup } from '../src/ageGroups.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSha256 = '5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c';
const rulesSha256 = '1cfb3c5d9882481393bc420d234656f7839fcca22c22bd71632a991c25ddf735';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareExampleModule() {
  const bytes = await readFile(path.join(root, 'data/example/example_data.csv'));
  const rulesBytes = await readFile(path.join(root, 'data/example/dgp_fixed_before_sampling.json'));
  if (hash(bytes) !== sourceSha256 || hash(rulesBytes) !== rulesSha256)
    throw new Error('The approved independent example or its fixed rules changed. Review the source before preparing it.');
  const rules = JSON.parse(rulesBytes.toString('utf8'));
  // The hash-verified source is the fixed four-column R write.csv output, not
  // arbitrary uploads. The application retains its full CSV parser for users.
  const records = bytes.toString('utf8').trim().split(/\r?\n/)
    .map(line => line.split(',').map(value => value.replace(/^"(.*)"$/, '$1')));
  if (records.shift().join(',') !== 'Year,Age_Group,Count,Pop') throw new Error('Unexpected example columns.');
  const groups = new Map(), seen = new Set();
  const rows = records.map(cells => {
    const [period, label, count, exposure] = cells;
    const Year = Number(period), Deaths = Number(count), Pop = Number(exposure), group = parseAgeGroup(label);
    if (cells.length !== 4 || !group || !Number.isSafeInteger(Year) || !Number.isSafeInteger(Deaths) ||
        Deaths < 0 || !Number.isSafeInteger(Pop) || Pop <= 0) throw new Error('Invalid fixed example observation.');
    const key = `${Year}|${group.midpoint}`;
    if (seen.has(key)) throw new Error('Duplicate example coordinate.');
    seen.add(key); groups.set(group.midpoint, { midpoint: group.midpoint, lower: group.lower, upper: group.upper });
    return { Year, Age_Mid: group.midpoint, Deaths, Pop };
  });
  const years = [...new Set(rows.map(row => row.Year))].sort((a, b) => a - b);
  const ageGroups = [...groups.values()].sort((a, b) => a.midpoint - b.midpoint);
  if (rows.length !== 442 || years.length !== 34 || years[0] !== 1990 || years.at(-1) !== 2023 ||
      ageGroups.length !== 13 || ageGroups[0].midpoint !== 32.5 || ageGroups.at(-1).midpoint !== 92.5 ||
      rows.some((row, i) => row.Year !== years[Math.floor(i / 13)] || row.Age_Mid !== ageGroups[i % 13].midpoint))
    throw new Error('The fixed example grid or observation order changed.');
  const metadata = {
    source: 'INDEPENDENT_SYNTHETIC_COUNT_EXPOSURE', filename: 'example_data.csv',
    simulated: true, derived: false, originalEstimates: false,
    version: rules.version, dataset: 'Independent simulated mortality example', measure: 'Count', sex: null,
    generationSeed: rules.generationSeed, coefficientSeed: rules.coefficientSeed,
    years: [years[0], years.at(-1)], ageMidpoints: ageGroups.map(group => group.midpoint), ageGroups,
    boundedAgeGroups: ['30-34', '90-94'], rows: rows.length, sourceSha256,
    sourceFile: 'data/example/example_data.csv', generationRulesSha256: rulesSha256, generationRules: rules,
    sourceGenerationScript: '../output/BLSD-S_web_manuscript/simulated_results_revision_20261022/generate_and_fit_simulated_example.R',
    sourceGenerationScriptSha256: '83a80b82f2dd9a5f2458617def51460949967fd5ef356bb1584a1f53348ee9bd',
    defaultSettings: { method: 'nb-reml', draws: 1000, seed: 123, kAge: 10, kYear: 10, threshold: 0.005 },
    interpretation: 'Independently simulated mortality counts and exposure, not observations from a real population. The one approved realization is retained unchanged. Fitted results and pointwise uncertainty intervals are produced only by the actual R model after analysis.',
  };
  await mkdir(path.join(root, 'public/demo'), { recursive: true });
  await writeFile(path.join(root, 'src/generated/exampleCounts.js'),
    `// Prepared from the fixed independent simulated observations; no fitted results.\nexport const demoMetadata = Object.freeze(${JSON.stringify(metadata)});\nexport const demoProvenance = demoMetadata;\nexport const demoInputCsv = ${JSON.stringify(bytes.toString('utf8'))};\nexport const demoRows = ${JSON.stringify(rows)};\n`);
  // Both the static CSV and the UI download preserve the authoritative bytes.
  await writeFile(path.join(root, 'public/demo/example_data.csv'), bytes);
  await writeFile(path.join(root, 'data/example/metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(root, 'public/demo/metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(root, 'public/demo/README.md'), '# Independent simulated example / 独立模拟示例\n\nYear, Age_Group, Count, Pop; 442 fixed observations, 1990–2023, 13 closed five-year age groups from 30-34 through 90-94; no Sex column. These mortality counts and exposures were generated independently of real data. Generation seed: 20261022; one negative-binomial realization with generating size=300. This generating parameter is distinct from the fitted model theta. Counts are imported unchanged, without resampling. Source and fixed rules are recorded in metadata.json.\n\n这是独立生成的模拟死亡率计数与人口/暴露示例，不代表真实人群。只保留一次既定抽样的全部观测，不重新抽样；数据生成参数 size=300 与拟合 theta 不同。网页初始为空，加载示例后仍需运行分析；所有图表和区间均来自实际保留的 R 拟合。\n');
  console.log(`Prepared ${rows.length} fixed independent simulated observations; SHA-256 ${sourceSha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareExampleModule();
