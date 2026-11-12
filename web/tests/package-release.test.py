"""Regression checks for the runtime allowlist; never creates an archive."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from datetime import timezone


PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('blsd_package_release', PROJECT / 'scripts/package-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PackagingBoundary(Exception):
    """Stop main after staging and validation, before opening any ZIP."""


class RuntimePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='blsd-package-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, relative, content=''):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        return target

    def valid_runtime(self):
        self.write('server/index.mjs', "import './api.mjs'; import http from 'node:http';\n")
        self.write('server/api.mjs', "import { ages } from '../src/ageGroups.js';\n")
        self.write('src/ageGroups.js', 'export const ages = [];\n')
        self.write('src/bothGroups.js', 'export const groups = [];\n')
        self.write('deployment/check-environment.mjs', "import fs from 'node:fs';\n")
        self.write('dist/client/index.html', '<script src="/assets/app.js"></script><link href="/assets/app.css" rel="stylesheet">')
        self.write('dist/client/assets/app.js', 'console.log("prebuilt");\n')
        self.write('dist/client/assets/app.css', '@font-face{font-family:Inter;src:url(./inter.woff2)}')
        self.write('dist/client/assets/inter.woff2', 'fixture font bytes')
        release.validate_runtime(self.root)

    def test_real_runtime_sources_excludes_development_and_preserves_built_assets(self):
        sources = release.runtime_sources()
        relative = {source.relative_to(PROJECT).as_posix() for source in sources}
        self.assertEqual({name.removeprefix('server/') for name in relative if name.startswith('server/')},
                         set(release.SERVER_FILES))
        self.assertEqual({name for name in relative if name.startswith('src/')},
                         {'src/ageGroups.js', 'src/bothGroups.js'})
        self.assertEqual({name.removeprefix('deployment/') for name in relative if name.startswith('deployment/')},
                         set(release.DEPLOYMENT_FILES))
        self.assertIn('dist/client/index.html', relative)
        actual_assets = {file.relative_to(PROJECT).as_posix()
                         for file in (PROJECT / 'dist/client/assets').rglob('*') if file.is_file()}
        self.assertEqual({name for name in relative if name.startswith('dist/client/assets/')}, actual_assets)
        expected = actual_assets | {'LICENSE', 'dist/client/index.html', 'src/ageGroups.js', 'src/bothGroups.js'}
        expected |= {f'server/{name}' for name in release.SERVER_FILES}
        expected |= {f'deployment/{name}' for name in release.DEPLOYMENT_FILES}
        self.assertEqual(relative, expected)
        self.assertTrue(any(name.endswith('.woff2') for name in relative))
        for name in relative:
            self.assertNotIn('/.jobs/', name)
            self.assertNotIn('/.launcher/', name)
            self.assertNotIn('node_modules/', name)
            self.assertNotIn('tests/', name)
            self.assertNotIn('worker/', name)
            self.assertNotIn('.openai/', name)
            self.assertFalse(name.endswith(('.log', '.rds', '.jsx', '.test.mjs', '.map')))

    def test_missing_relative_module_is_rejected(self):
        self.valid_runtime()
        (self.root / 'src/ageGroups.js').unlink()
        with self.assertRaisesRegex(RuntimeError, r'Missing runtime import: api\.mjs: ../src/ageGroups\.js'):
            release.validate_runtime(self.root)

    def test_missing_font_and_asset_path_escape_are_rejected(self):
        self.valid_runtime()
        font = self.root / 'dist/client/assets/inter.woff2'
        font.unlink()
        with self.assertRaisesRegex(RuntimeError, r'Missing built asset: app\.css: ./inter\.woff2'):
            release.validate_runtime(self.root)
        font.write_bytes(b'font')
        self.write('dist/client/assets/app.css', '@font-face{src:url(../../../outside.woff2)}')
        self.write('outside.woff2', 'existing file outside client root')
        with self.assertRaisesRegex(RuntimeError, 'Missing built asset'):
            release.validate_runtime(self.root)

    def test_external_node_dependencies_are_rejected(self):
        self.valid_runtime()
        for statement in ("import express from 'express';", "import '@fontsource/inter/400.css';"):
            with self.subTest(statement=statement):
                self.write('server/api.mjs', statement)
                with self.assertRaisesRegex(RuntimeError, 'Unexpected external Node dependency'):
                    release.validate_runtime(self.root)

    def test_staged_package_metadata_has_runtime_scripts_without_install_dependencies(self):
        self.valid_runtime()
        for filename in release.SERVER_FILES:
            target = self.root / 'server' / filename
            if not target.exists():
                self.write(f'server/{filename}', '# R fixture\n' if filename.endswith('.R') else '')
        for filename in release.DEPLOYMENT_FILES:
            target = self.root / 'deployment' / filename
            if not target.exists():
                self.write(f'deployment/{filename}')
        self.write(f'deployment/{release.GUIDE}', 'Linux runtime fixture guide')
        license_text = 'MIT License\n\nFixture license text.\n'
        self.write('LICENSE', license_text)
        original = {'name': 'runtime-fixture', 'version': '1.2.3', 'private': True,
                    'license': 'MIT', 'type': 'module', 'engines': {'node': '>=22.12.0'},
                    'packageManager': 'pnpm@example', 'scripts': {'dev': 'vite', 'test': 'node --test'},
                    'dependencies': {'vite': 'example'}, 'devDependencies': {'unused': 'example'}}
        self.write('package.json', json.dumps(original))
        delivery = self.root / 'delivery'
        with mock.patch.object(release, 'ROOT', self.root), \
                mock.patch.object(release, 'ZoneInfo', return_value=timezone.utc), \
                mock.patch.object(release, 'third_party_notices', return_value='fixture notices'), \
                mock.patch.object(release.zipfile, 'ZipFile', side_effect=PackagingBoundary) as zip_file, \
                mock.patch('sys.argv', ['package-release.py', '--output-dir', str(delivery)]):
            with self.assertRaises(PackagingBoundary):
                release.main()
            zip_file.assert_called_once()
        stages = list((self.root / 'tmp/releases').glob('*/blsd-tool'))
        self.assertEqual(len(stages), 1)
        package = json.loads((stages[0] / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual({key: package[key] for key in ('name', 'version', 'license', 'private', 'type', 'engines')},
                         {key: original[key] for key in ('name', 'version', 'license', 'private', 'type', 'engines')})
        self.assertEqual(package['scripts'], {'start': 'node server/index.mjs',
                                             'check': 'node deployment/check-environment.mjs'})
        self.assertEqual(set(package), {'name', 'version', 'license', 'private', 'type', 'engines', 'scripts'})
        self.assertEqual((stages[0] / 'LICENSE').read_text(encoding='utf-8'), license_text)
        self.assertTrue((stages[0] / release.GUIDE).is_file())
        self.assertFalse(list(self.root.rglob('*.zip')), 'The regression must stop before creating an archive.')


if __name__ == '__main__':
    unittest.main()
