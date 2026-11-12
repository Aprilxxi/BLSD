"""Package the Linux production runtime using an explicit file allowlist."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse
import hashlib
import json
import re
import shutil
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SERVER_FILES = (
    'index.mjs', 'api.mjs', 'results-download.mjs', 'readable-results.mjs',
    'results-workbook.mjs', 'analysis-downloads.mjs', 'job-lifecycle.mjs',
    'async-tasks.mjs', 'task-results.mjs', 'blsd_adapter.R', 'blsd_export.R',
)
DEPLOYMENT_FILES = (
    'deploy-linux.sh', 'start-linux.sh', 'check-environment.mjs', 'check-r.R',
    'install-r-packages.R', 'fonts.conf.example', 'blsd.service.example',
    'nginx.conf.example',
)
GUIDE = 'DEPLOYMENT_LINUX_zh.txt'
ARCHIVE_ROOT = 'blsd-tool'


def runtime_sources():
    files = [ROOT / 'LICENSE', ROOT / 'dist/client/index.html']
    # Vite clears assets on each build. Keep every built font variant unchanged.
    assets = ROOT / 'dist/client/assets'
    if not assets.is_dir() or assets.is_symlink():
        raise RuntimeError('Build the client before packaging.')
    for file in assets.rglob('*'):
        if file.is_symlink():
            raise RuntimeError(f'Unexpected runtime asset link: {file}')
        if file.is_file():
            if file.suffix not in {'.js', '.css', '.woff', '.woff2'}:
                raise RuntimeError(f'Unexpected runtime asset: {file}')
            files.append(file)
    files += [ROOT / 'server' / name for name in SERVER_FILES]
    files += [ROOT / 'src' / name for name in ('ageGroups.js', 'bothGroups.js')]
    files += [ROOT / 'deployment' / name for name in DEPLOYMENT_FILES]
    for file in files:
        if not file.is_file() or file.is_symlink():
            raise RuntimeError(f'Missing or linked runtime file: {file}')
    return sorted(set(files))


def validate_runtime(directory):
    """Check the archive's import/asset closure, independent of node_modules."""
    for folder in ('server', 'src', 'deployment'):
        for file in (directory / folder).glob('*'):
            if file.suffix not in {'.js', '.mjs'}:
                continue
            for specifier in re.findall(r'(?:from\s*|import\s*)[\'\"]([^\'\"]+)[\'\"]', file.read_text(encoding='utf-8')):
                if specifier.startswith('node:'):
                    continue
                if not specifier.startswith('.'):
                    raise RuntimeError(f'Unexpected external Node dependency: {file.name}: {specifier}')
                target = (file.parent / specifier).resolve()
                if not target.is_relative_to(directory.resolve()) or not target.is_file():
                    raise RuntimeError(f'Missing runtime import: {file.name}: {specifier}')
    client = directory / 'dist/client'
    for file in client.rglob('*'):
        if file.suffix not in {'.html', '.js', '.css'}:
            continue
        source = file.read_text(encoding='utf-8')
        references = re.findall(r'[\'\"(](/assets/[^\s\'\")]+)', source)
        if file.suffix == '.css':
            references += re.findall(r'url\([\'\"]?([^\s\'\")]+)', source)
        for reference in references:
            if reference.startswith(('data:', 'https:', 'http:')):
                continue
            target = (client / reference.lstrip('/') if reference.startswith('/') else file.parent / reference).resolve()
            if not target.is_relative_to(client.resolve()) or not target.is_file():
                raise RuntimeError(f'Missing built asset: {file.name}: {reference}')


def third_party_notices():
    packages = ('react', 'react-dom', 'echarts', 'zrender', 'tslib', '@phosphor-icons/react', '@fontsource/inter')
    notices = ['Third-party licenses for bundled application assets.\n']
    for package in packages:
        directory = ROOT / 'node_modules' / package
        if not directory.is_dir():
            candidates = sorted((ROOT / 'node_modules/.pnpm').glob(f'{package.replace("/", "+")}@*/node_modules/{package}'))
            if not candidates:
                raise RuntimeError(f'Cannot locate license for {package}')
            directory = candidates[0]
        licenses = sorted(p for p in directory.iterdir() if p.is_file() and
            (p.name.lower().startswith(('license', 'licence', 'copying')) or p.name.lower() == 'ofl.txt'))
        if not licenses:
            raise RuntimeError(f'Cannot locate license text for {package}')
        for file in licenses:
            notices.append(f'\n===== {package} / {file.name} =====\n' + file.read_text(encoding='utf-8', errors='replace'))
    return '\n'.join(notices)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--linux', action='store_true', help='Compatibility option: releases target Linux.')
    parser.add_argument('--output-dir', type=Path, help='Use a new delivery directory; never replace an existing archive.')
    options = parser.parse_args()
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    date = now.strftime('%Y%m%d')
    stem = f'BLSD_Tool_Linux_{date}'
    output = options.output_dir.resolve() if options.output_dir else ROOT.parent / 'output/deployment' / now.strftime('BLSD_Tool_%Y%m%d_%H%M%S')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'{stem}.zip'
    if archive.exists():
        raise RuntimeError('Archive already exists. Choose a new --output-dir to preserve the earlier delivery.')
    stage = ROOT / 'tmp/releases' / f'blsd-release-{date}-{uuid.uuid4().hex[:8]}' / ARCHIVE_ROOT
    stage.mkdir(parents=True)
    for source in runtime_sources():
        target = stage / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    guide = ROOT / 'deployment' / GUIDE
    if not guide.is_file() or guide.is_symlink():
        raise RuntimeError('Deployment instructions are not ready.')
    shutil.copy2(guide, stage / GUIDE)
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    runtime_package = {key: package[key] for key in ('name', 'version', 'license', 'private', 'type', 'engines')}
    runtime_package['scripts'] = {'start': 'node server/index.mjs', 'check': 'node deployment/check-environment.mjs'}
    (stage / 'package.json').write_text(json.dumps(runtime_package, indent=2) + '\n', encoding='utf-8')
    (stage / 'THIRD_PARTY_NOTICES.txt').write_text(third_party_notices(), encoding='utf-8')
    validate_runtime(stage)
    entries = [{'path': file.relative_to(stage).as_posix(), 'bytes': file.stat().st_size,
        'sha256': hashlib.sha256(file.read_bytes()).hexdigest()} for file in sorted(stage.rglob('*')) if file.is_file()]
    manifest = {
        'name': 'BLSD Tool', 'releaseDate': date, 'format': 'prebuilt-node-r-runtime',
        'deploymentTarget': 'Linux (Ubuntu 24.04 x64/arm64)',
        'deploymentGuide': GUIDE, 'deploymentScript': 'deployment/deploy-linux.sh',
        'guideConnected': False,
        'requiredRuntime': 'Node.js >=22.12, R with mgcv/jsonlite/scales/ggplot2, Cairo and TIFF support',
        'testedEnvironment': {'Node': '24.19.0', 'R': '4.4.3', 'mgcv': '1.9.1',
            'jsonlite': '2.0.0', 'scales': '1.4.0', 'ggplot2': '4.0.0', 'platform': 'Windows x64'},
        'excluded': ['node_modules', 'Node/R installations', 'frontend development sources',
            'tests and QA', 'Sites adapters', 'build tools and lockfiles', 'original research data',
            'unused public demo/simulation copies', 'fit/job caches', 'launcher identities',
            'logs and screenshots', 'user result files', 'PDF user guide', 'Windows launchers'],
        'files': entries,
    }
    (stage / 'RELEASE_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=False) as zipped:
        for file in sorted(stage.rglob('*')):
            if not file.is_file():
                continue
            name = (Path(ARCHIVE_ROOT) / file.relative_to(stage)).as_posix()
            info = zipfile.ZipInfo.from_file(file, name, strict_timestamps=False)
            info.create_system = 3
            info.external_attr = (0o100755 if file.suffix == '.sh' else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zipped.writestr(info, file.read_bytes(), compresslevel=9)
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError('Archive CRC verification failed.')
        expected = {ARCHIVE_ROOT + '/' + entry['path'] for entry in entries} | {ARCHIVE_ROOT + '/RELEASE_MANIFEST.json'}
        if set(zipped.namelist()) != expected:
            raise RuntimeError('Archive does not match its allowlisted manifest.')
        for entry in entries:
            data = zipped.read(ARCHIVE_ROOT + '/' + entry['path'])
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise RuntimeError(f'Archive content changed: {entry["path"]}')
    sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / f'{stem}.sha256').write_text(f'{sha}  {archive.name}\n', encoding='ascii')
    shutil.copy2(guide, output / f'Linux_部署说明_{date}.txt')
    print(json.dumps({'archive': str(archive), 'stage': str(stage), 'bytes': archive.stat().st_size,
        'files': len(entries) + 1, 'sha256': sha}, ensure_ascii=True))


if __name__ == '__main__':
    main()
