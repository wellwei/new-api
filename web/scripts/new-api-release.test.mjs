import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  extractRoutes,
  generateRelease,
  validateReleaseId,
} from './new-api-release.mjs'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRevision = '0123456789abcdef0123456789abcdef01234567'
const routeTree = `export interface FileRoutesByFullPath {
  '/pricing/$modelId': typeof PricingModelRoute
  '/pricing/$modelId/': typeof PricingModelIndexRoute
  '/': typeof IndexRoute
  '/oauth/$provider': typeof OauthProviderRoute
}
export interface FileRoutesByTo {
  '/not-a-full-path': typeof OtherRoute
}
`

function fixture(context) {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), 'new-api-release-')
  )
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const dist = path.join(root, 'dist')
  mkdirSync(path.join(dist, 'static/js'), { recursive: true })
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'public'))
  writeFileSync(path.join(root, 'src/routeTree.gen.ts'), routeTree)
  writeFileSync(path.join(dist, 'index.html'), '<html><head></head></html>')
  writeFileSync(path.join(dist, 'static/js/lazy.js'), 'hello')
  writeFileSync(path.join(root, 'public/favicon.ico'), 'favicon')
  writeFileSync(path.join(dist, 'favicon.ico'), 'favicon')
  return {
    root,
    dist,
    options: {
      dist,
      webRoot: root,
      releaseId: 'r1',
      sourceRevision,
      version: 'v1.0.0-dirty',
    },
  }
}

function configProbe(env = {}) {
  const childEnv = { ...process.env }
  for (const name of [
    'NEW_API_WEB_RELEASE_ID',
    'NEW_API_WEB_DIST',
    'UMAMI_WEBSITE_ID',
    'UMAMI_SCRIPT_URL',
    'GOOGLE_ANALYTICS_ID',
  ]) {
    delete childEnv[name]
  }
  return spawnSync(
    'bun',
    [
      '-e',
      `
    const { default: config } = await import('./rsbuild.config.ts');
    const result = config({ envMode: 'production' });
    console.log(JSON.stringify({ output: result.output, html: result.html }));
  `,
    ],
    { cwd: webRoot, env: { ...childEnv, ...env }, encoding: 'utf8' }
  )
}

test('route extraction preserves actual dynamic fullPaths and excludes other interfaces', () => {
  assert.deepEqual(extractRoutes(routeTree), [
    '/',
    '/oauth/$provider',
    '/pricing/$modelId',
    '/pricing/$modelId/',
  ])
  const routes = extractRoutes(
    readFileSync(path.join(webRoot, 'src/routeTree.gen.ts'), 'utf8')
  )
  assert.ok(routes.includes('/pricing/$modelId/'))
  assert.ok(routes.includes('/oauth/$provider'))
  assert.ok(routes.includes('/system-settings/auth/$section'))
})

test('empty, ambiguous, malformed and injectable route tables fail closed', () => {
  for (const source of [
    '',
    'export interface FileRoutesByFullPath {\n}\n',
    routeTree + routeTree,
    'export interface FileRoutesByFullPath {\n  invalid: string\n}\n',
    "export interface FileRoutesByFullPath {\n  '/pricing/$modelId': string\n}\n",
    "export interface FileRoutesByFullPath {\n  '/a': typeof Route\n  '/a': typeof Route\n}\n",
    ...[
      '/../api',
      '//api',
      '/a\\b',
      '/a?b',
      '/a#b',
      '/a*',
      '/a;evil',
      '/a\nhandle',
      '/a"b',
    ].map(
      (route) =>
        `export interface FileRoutesByFullPath {\n  '${route}': typeof Route\n}\n`
    ),
  ]) {
    assert.throws(() => extractRoutes(source))
  }
})

test('release IDs use the strict bounded grammar without path or content injection', () => {
  for (const id of ['a', '20260930-main.1_dirty', 'a'.repeat(128)]) {
    assert.equal(validateReleaseId(id), id)
  }
  for (const id of [
    undefined,
    null,
    123,
    '',
    '.',
    '..',
    '-id',
    '_id',
    'a'.repeat(129),
    '../id',
    'id/path',
    'id\\path',
    'id?x',
    'id\n',
    'id"',
    'id%20',
  ]) {
    assert.throws(() => validateReleaseId(id), /Invalid release ID/)
  }
})

test('manifest hashes all artifacts, lists only copied public files, and is deterministic', (context) => {
  const setup = fixture(context)
  mkdirSync(path.join(setup.root, 'public/nested'))
  mkdirSync(path.join(setup.dist, 'nested'))
  writeFileSync(path.join(setup.root, 'public/nested/logo.svg'), '<svg/>')
  writeFileSync(path.join(setup.dist, 'nested/logo.svg'), '<svg/>')
  writeFileSync(path.join(setup.root, 'public/not-copied.png'), 'not copied')
  const manifest = generateRelease(setup.options)
  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.release_id, 'r1')
  assert.equal(manifest.asset_prefix, '/static/new-api/r1/')
  assert.equal(manifest.source_revision, sourceRevision)
  assert.equal(manifest.frontend_version, 'v1.0.0-dirty')
  assert.deepEqual(manifest.public_files, ['favicon.ico', 'nested/logo.svg'])
  assert.deepEqual(Object.keys(manifest.files), [
    'favicon.ico',
    'index.html',
    'nested/logo.svg',
    'static/js/lazy.js',
  ])
  assert.equal(
    manifest.files['static/js/lazy.js'],
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  )
  assert.ok(
    Object.values(manifest.files).every((hash) => /^[a-f0-9]{64}$/.test(hash))
  )
  assert.deepEqual(manifest.routes, [
    '/',
    '/oauth/$provider',
    '/pricing/$modelId',
    '/pricing/$modelId/',
  ])
  const first = readFileSync(path.join(setup.dist, 'release.json'), 'utf8')
  assert.deepEqual(generateRelease(setup.options), manifest)
  assert.equal(
    readFileSync(path.join(setup.dist, 'release.json'), 'utf8'),
    first
  )
  rmSync(path.join(setup.dist, 'release.json'))
  generateRelease(setup.options)
  assert.equal(
    readFileSync(path.join(setup.dist, 'release.json'), 'utf8'),
    first
  )
})

test('mutated files or metadata cannot overwrite an existing immutable manifest', (context) => {
  const setup = fixture(context)
  generateRelease(setup.options)
  const original = readFileSync(path.join(setup.dist, 'release.json'), 'utf8')
  assert.throws(
    () => generateRelease({ ...setup.options, version: 'v2' }),
    /differs/
  )
  writeFileSync(path.join(setup.dist, 'static/js/lazy.js'), 'changed')
  assert.throws(() => generateRelease(setup.options), /differs/)
  assert.equal(
    readFileSync(path.join(setup.dist, 'release.json'), 'utf8'),
    original
  )
})

test('namespaced git-describe dirty versions remain metadata, not artifact paths', (context) => {
  const setup = fixture(context)
  const manifest = generateRelease({
    ...setup.options,
    version: 'relaykit/v0.2.1-40-g755a3d52c-dirty',
  })
  assert.equal(manifest.frontend_version, 'relaykit/v0.2.1-40-g755a3d52c-dirty')
  assert.equal(manifest.asset_prefix, '/static/new-api/r1/')
})

test('missing dist, missing index, empty index and non-file index are rejected', (context) => {
  const setup = fixture(context)
  assert.throws(
    () =>
      generateRelease({
        ...setup.options,
        dist: path.join(setup.root, 'absent'),
      }),
    /ENOENT/
  )
  rmSync(path.join(setup.dist, 'index.html'))
  assert.throws(() => generateRelease(setup.options), /index.html/)
  writeFileSync(path.join(setup.dist, 'index.html'), '')
  assert.throws(() => generateRelease(setup.options), /index.html/)
  rmSync(path.join(setup.dist, 'index.html'))
  mkdirSync(path.join(setup.dist, 'index.html'))
  assert.throws(() => generateRelease(setup.options), /index.html/)
  assert.equal(existsSync(path.join(setup.dist, 'release.json')), false)
})

test('unsafe metadata and artifact names are rejected before writing a manifest', (context) => {
  const setup = fixture(context)
  for (const sourceRevision of [
    'abcdef',
    'x'.repeat(40),
    `${'a'.repeat(40)}\n`,
    '</script>',
  ]) {
    assert.throws(
      () => generateRelease({ ...setup.options, sourceRevision }),
      /Git SHA/
    )
  }
  for (const version of [
    123,
    '',
    'a\nhandle',
    'a"b',
    '</script>',
    '../version',
    'release/../version',
    'release//version',
  ]) {
    assert.throws(
      () => generateRelease({ ...setup.options, version }),
      /version/
    )
  }
  writeFileSync(path.join(setup.dist, 'unsafe\nhandle.js'), 'injection')
  assert.throws(() => generateRelease(setup.options), /Unsafe artifact path/)
  assert.equal(existsSync(path.join(setup.dist, 'release.json')), false)
})

test('dist, index, nested directory, public and manifest symlinks are rejected', (context) => {
  for (const target of [
    'dist',
    'index.html',
    'static/js/link.js',
    'static/directory',
    'release.json',
    'public',
    'src/routeTree.gen.ts',
  ]) {
    const setup = fixture(context)
    let linkPath
    if (target === 'dist') {
      linkPath = path.join(setup.root, 'dist-link')
      symlinkSync(setup.dist, linkPath)
    } else if (target === 'public') {
      rmSync(path.join(setup.root, 'public'), { recursive: true })
      symlinkSync(setup.dist, path.join(setup.root, 'public'))
    } else if (target.startsWith('src/')) {
      rmSync(path.join(setup.root, target))
      symlinkSync(
        path.join(setup.dist, 'index.html'),
        path.join(setup.root, target)
      )
    } else {
      linkPath = path.join(setup.dist, target)
      rmSync(linkPath, { force: true })
      symlinkSync(path.join(setup.root, 'src/routeTree.gen.ts'), linkPath)
    }
    assert.throws(
      () =>
        generateRelease({
          ...setup.options,
          dist: target === 'dist' ? linkPath : setup.dist,
        }),
      /Symlinks/
    )
  }
})

test('CLI requires explicit metadata and reads the actual generated route tree', (context) => {
  const setup = fixture(context)
  const command = path.join(webRoot, 'scripts/new-api-release.mjs')
  const missing = spawnSync('bun', [command, '--dist', setup.dist], {
    encoding: 'utf8',
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Missing --release-id/)
  const result = spawnSync(
    'bun',
    [
      command,
      '--dist',
      setup.dist,
      '--release-id',
      'cli-r1',
      '--source-revision',
      sourceRevision,
      '--version',
      'v1.0.0',
    ],
    { cwd: webRoot, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(
    readFileSync(path.join(setup.dist, 'release.json'), 'utf8')
  )
  assert.equal(manifest.release_id, 'cli-r1')
  assert.ok(manifest.routes.includes('/pricing/$modelId/'))
  assert.ok(!manifest.routes.includes('/not-a-full-path'))
})

test('embedded config retains the original HTML and ignores split-only analytics', () => {
  const result = configProbe({
    NEW_API_WEB_DIST: '/ignored/split',
    UMAMI_WEBSITE_ID: 'unsafe"',
    GOOGLE_ANALYTICS_ID: 'unsafe</script>',
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(Object.hasOwn(config.output, 'assetPrefix'), false)
  assert.equal(config.output.distPath.root, 'dist')
  assert.deepEqual(config.html, {
    template: './index.html',
    favicon: './public/favicon.ico',
  })
})

test(
  'split output root permits safe destinations and rejects protected paths and aliases before build',
  { timeout: 30000 },
  (context) => {
    const setup = fixture(context)
    // 仅求值构建配置，不执行危险构建；真实源码作为只读哨兵，退出时校验未被删除或改写。
    const sentinelPath = path.join(webRoot, 'src/main.tsx')
    const sentinel = readFileSync(sentinelPath)
    context.after(() => assert.deepEqual(readFileSync(sentinelPath), sentinel))
    const sourceRoot = path.dirname(webRoot)
    const goSentinelPath = path.join(sourceRoot, 'router/web-router.go')
    const goSentinel = readFileSync(goSentinelPath)
    context.after(() =>
      assert.deepEqual(readFileSync(goSentinelPath), goSentinel)
    )
    const goOverride = configProbe({
      NEW_API_WEB_RELEASE_ID: 'r1',
      NEW_API_WEB_DIST: '../router',
    })
    assert.notEqual(goOverride.status, 0, '../router must fail before build')
    const sourceOverride = configProbe({
      NEW_API_WEB_RELEASE_ID: 'r1',
      NEW_API_WEB_DIST: 'src',
    })
    assert.notEqual(sourceOverride.status, 0, 'src must fail before build')
    const safeOutput = path.join(setup.root, 'safe-output')
    mkdirSync(safeOutput)
    const safeAlias = path.join(setup.root, 'safe-alias')
    symlinkSync(safeOutput, safeAlias)
    for (const [dist, expected] of [
      ['/absolute/release/r1', '/absolute/release/r1'],
      ['../../bin/web/r1', path.resolve(webRoot, '../../bin/web/r1')],
      ['dist', path.join(webRoot, 'dist')],
      ['dist/nested/release', path.join(webRoot, 'dist/nested/release')],
      ['src-output/release', path.join(webRoot, 'src-output/release')],
      [
        path.join(setup.root, 'src/release'),
        path.join(setup.root, 'src/release'),
      ],
      [
        path.join(safeAlias, 'missing/release'),
        path.join(safeOutput, 'missing/release'),
      ],
    ]) {
      const result = configProbe({
        NEW_API_WEB_RELEASE_ID: 'r1',
        NEW_API_WEB_DIST: dist,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).output.distPath.root, expected)
    }
    const result = configProbe({ NEW_API_WEB_RELEASE_ID: 'r1' })
    assert.equal(JSON.parse(result.stdout).output.distPath.root, 'dist')
    const empty = configProbe({
      NEW_API_WEB_RELEASE_ID: 'r1',
      NEW_API_WEB_DIST: '',
    })
    assert.notEqual(empty.status, 0)
    const unsafePaths = ['.', '..', webRoot, path.parse(webRoot).root]
    // 用实际配置所在仓库定位兄弟目录，不把外部临时 fixture 的 src/public 误判为源码。
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (entry.name !== 'web' && entry.isDirectory()) {
        unsafePaths.push(
          `../${entry.name}`,
          path.join(sourceRoot, entry.name, 'missing/release')
        )
      }
    }
    for (const directory of ['src', 'public', 'scripts', 'node_modules']) {
      unsafePaths.push(
        directory,
        `${directory}/missing/release`,
        `dist/../${directory}/missing/release`,
        path.join(webRoot, directory),
        path.join(webRoot, directory, 'missing/release')
      )
    }
    for (const [name, target] of [
      ['src-alias', path.join(webRoot, 'src')],
      ['public-alias', path.join(webRoot, 'public')],
      ['scripts-alias', path.join(webRoot, 'scripts')],
      ['modules-alias', path.join(webRoot, 'node_modules')],
      ['go-alias', path.join(sourceRoot, 'router')],
      ['go-subtree-alias', path.join(sourceRoot, 'relaykit')],
      ['web-alias', webRoot],
      ['parent-alias', path.dirname(webRoot)],
      ['root-alias', path.parse(webRoot).root],
    ]) {
      const alias = path.join(setup.root, name)
      symlinkSync(target, alias)
      unsafePaths.push(alias)
      if (!['web-alias', 'parent-alias', 'root-alias'].includes(name)) {
        unsafePaths.push(path.join(alias, 'missing/nested/release'))
      } else if (name === 'web-alias') {
        unsafePaths.push(path.join(alias, 'src/missing/nested/release'))
      } else if (name === 'parent-alias') {
        unsafePaths.push(path.join(alias, 'web/public/missing/release'))
      }
    }
    const aliasParent = path.join(setup.root, 'alias-parent')
    mkdirSync(aliasParent)
    symlinkSync(path.join(webRoot, 'src'), path.join(aliasParent, 'source'))
    unsafePaths.push(path.join(aliasParent, 'source/missing/release'))
    const brokenAlias = path.join(setup.root, 'broken-alias')
    symlinkSync(path.join(setup.root, 'absent-target'), brokenAlias)
    unsafePaths.push(brokenAlias, path.join(brokenAlias, 'missing/release'))
    const fileAlias = path.join(setup.root, 'file-alias')
    symlinkSync(sentinelPath, fileAlias)
    unsafePaths.push(fileAlias, path.join(fileAlias, 'missing/release'))
    for (const dist of unsafePaths) {
      const unsafe = configProbe({
        NEW_API_WEB_RELEASE_ID: 'r1',
        NEW_API_WEB_DIST: dist,
      })
      assert.notEqual(unsafe.status, 0, dist)
      assert.match(unsafe.stderr, /NEW_API_WEB_DIST/, dist)
    }
  }
)

test('split config uses the release prefix and injects only validated public analytics', () => {
  const result = configProbe({
    NEW_API_WEB_RELEASE_ID: 'release.1_dirty',
    UMAMI_WEBSITE_ID: 'test-website',
    UMAMI_SCRIPT_URL: 'https://analytics.example/script.js?one=1&two=2',
    GOOGLE_ANALYTICS_ID: 'G-ABC123',
    PRIVATE_BACKEND_SECRET: 'must-never-be-public',
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(config.output.assetPrefix, '/static/new-api/release.1_dirty/')
  assert.equal(
    config.html.tags[0].attrs.src,
    'https://analytics.example/script.js?one=1&amp;two=2'
  )
  assert.equal(config.html.tags[0].attrs['data-website-id'], 'test-website')
  assert.equal(config.html.tags[0].publicPath, false)
  assert.equal(
    config.html.tags[1].attrs.src,
    'https://www.googletagmanager.com/gtag/js?id=G-ABC123'
  )
  assert.match(config.html.tags[2].children, /gtag\('config', "G-ABC123"\)/)
  assert.ok(!result.stdout.includes('must-never-be-public'))
  const defaults = configProbe({
    NEW_API_WEB_RELEASE_ID: 'r1',
    UMAMI_WEBSITE_ID: 'test-website',
  })
  assert.equal(
    JSON.parse(defaults.stdout).html.tags[0].attrs.src,
    'https://analytics.umami.is/script.js'
  )
})

test('unsafe release IDs and analytics cannot inject paths, attributes or scripts', () => {
  for (const env of [
    { NEW_API_WEB_RELEASE_ID: '' },
    { NEW_API_WEB_RELEASE_ID: '..' },
    { NEW_API_WEB_RELEASE_ID: 'r1/../../api' },
    { UMAMI_WEBSITE_ID: 'id" onload="evil' },
    { UMAMI_SCRIPT_URL: 'javascript:alert(1)' },
    { UMAMI_SCRIPT_URL: '//analytics.example/script.js' },
    { UMAMI_SCRIPT_URL: 'http://analytics.example/script.js' },
    { UMAMI_SCRIPT_URL: 'https://user:password@analytics.example/script.js' },
    { UMAMI_SCRIPT_URL: 'https://analytics.example/script.js#fragment' },
    { UMAMI_SCRIPT_URL: 'https://analytics.example/script.js" onload="evil' },
    { GOOGLE_ANALYTICS_ID: "G-ABC');evil();//" },
    { GOOGLE_ANALYTICS_ID: 'G-ABC</script><script>evil()</script>' },
  ]) {
    const result = configProbe({ NEW_API_WEB_RELEASE_ID: 'r1', ...env })
    assert.notEqual(result.status, 0, JSON.stringify(env))
  }
})

test('real fixture builds preserve embedded HTML and emit split lazy chunks with safe analytics', (context) => {
  const setup = fixture(context)
  writeFileSync(
    path.join(setup.root, 'entry.js'),
    "import('./lazy.js');document.getElementById('root').textContent='fixture'"
  )
  writeFileSync(
    path.join(setup.root, 'lazy.js'),
    "export const fixture = 'lazy fixture'"
  )
  for (const split of [false, true]) {
    const output = path.join(setup.root, split ? 'split' : 'embedded')
    const buildScript = `
      import { createRsbuild } from '@rsbuild/core';
      import config from './rsbuild.config.ts';
      const original = config({ envMode: 'production' });
      const build = await createRsbuild({ rsbuildConfig: {
        ...original,
        source: { entry: { index: ${JSON.stringify(path.join(setup.root, 'entry.js'))} } },
        output: ${split ? 'original.output' : `{ ...original.output, distPath: { root: ${JSON.stringify(output)} } }`},
        tools: {},
      } });
      await build.build();
    `
    const env = { ...process.env }
    for (const name of [
      'NEW_API_WEB_RELEASE_ID',
      'NEW_API_WEB_DIST',
      'UMAMI_WEBSITE_ID',
      'UMAMI_SCRIPT_URL',
      'GOOGLE_ANALYTICS_ID',
    ]) {
      delete env[name]
    }
    if (split) {
      Object.assign(env, {
        NEW_API_WEB_RELEASE_ID: 'fixture-r1',
        NEW_API_WEB_DIST: output,
        UMAMI_WEBSITE_ID: 'fixture-website',
        UMAMI_SCRIPT_URL: 'https://analytics.example/script.js?one=1&two=2',
        GOOGLE_ANALYTICS_ID: 'G-FIXTURE',
        PRIVATE_BACKEND_SECRET: 'do-not-expose',
      })
    }
    const result = spawnSync('bun', ['-e', buildScript], {
      cwd: webRoot,
      env,
      encoding: 'utf8',
      timeout: 60000,
    })
    assert.equal(result.status, 0, result.stderr)
    const html = readFileSync(path.join(output, 'index.html'), 'utf8')
    assert.match(html, /<title>New API<\/title>/)
    assert.match(html, /Unified AI API gateway and admin dashboard\./)
    assert.ok(!existsSync(path.join(output, 'release.json')))
    if (split) {
      assert.match(html, /src="\/static\/new-api\/fixture-r1\/static\/js\//)
      assert.match(html, /href="\/static\/new-api\/fixture-r1\/favicon.ico"/)
      assert.match(
        html,
        /https:\/\/analytics.example\/script.js\?one=1&amp;two=2/
      )
      assert.match(html, /data-website-id="fixture-website"/)
      assert.match(html, /G-FIXTURE/)
      assert.ok(!html.includes('do-not-expose'))
      const manifest = generateRelease({
        ...setup.options,
        dist: output,
        webRoot,
        releaseId: 'fixture-r1',
      })
      const javascript = Object.keys(manifest.files).filter((file) =>
        file.endsWith('.js')
      )
      assert.ok(
        javascript.length >= 2,
        'dynamic import must emit a separate lazy chunk'
      )
      const bundles = javascript
        .map((file) => readFileSync(path.join(output, file), 'utf8'))
        .join('\n')
      assert.ok(bundles.includes('/static/new-api/fixture-r1/'))
      assert.ok(!bundles.includes('do-not-expose'))
      assert.ok(manifest.public_files.includes('logo.png'))
    } else {
      assert.match(html, /src="\/static\/js\//)
      assert.match(html, /<!--umami-->/)
      assert.match(html, /<!--Google Analytics-->/)
      assert.ok(!html.includes('/static/new-api/'))
      assert.ok(!html.includes('googletagmanager.com'))
    }
  }
})
