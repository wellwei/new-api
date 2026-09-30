import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function validateReleaseId(releaseId) {
  if (
    typeof releaseId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) ||
    releaseId === '.' ||
    releaseId === '..'
  ) {
    throw new Error('Invalid release ID')
  }
  return releaseId
}

function validateRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath
      .split('/')
      .some(
        (segment) =>
          !/^[A-Za-z0-9_.@+-]+$/.test(segment) ||
          segment === '.' ||
          segment === '..'
      )
  ) {
    throw new Error(`Unsafe artifact path: ${relativePath}`)
  }
}

function assertNoSymlinks(filePath) {
  const absolutePath = path.resolve(filePath)
  let currentPath = path.parse(absolutePath).root
  for (const segment of absolutePath
    .slice(currentPath.length)
    .split(path.sep)) {
    currentPath = path.join(currentPath, segment)
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed: ${currentPath}`)
    }
  }
}

function readRegularFile(filePath) {
  assertNoSymlinks(filePath)
  if (!lstatSync(filePath).isFile()) {
    throw new Error(`Expected a regular file: ${filePath}`)
  }
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Expected a regular file: ${filePath}`)
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function artifactFiles(root, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory)
  assertNoSymlinks(directory)
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`Expected a directory: ${directory}`)
  }
  const files = []
  for (const name of readdirSync(directory).sort()) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${name}`
      : name
    validateRelativePath(relativePath)
    const filePath = path.join(root, relativePath)
    const metadata = lstatSync(filePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed: ${filePath}`)
    }
    if (metadata.isDirectory()) {
      files.push(...artifactFiles(root, relativePath))
    } else if (metadata.isFile()) {
      files.push(relativePath)
    } else {
      throw new Error(`Expected a regular file or directory: ${filePath}`)
    }
  }
  return files.sort()
}

export function extractRoutes(routeTree) {
  // 仅解析生成器实际输出的 fullPath 接口；格式漂移时失败，不猜测或执行源码。
  const interfaces = [
    ...routeTree.matchAll(
      /^export interface FileRoutesByFullPath \{\r?\n([\s\S]*?)^\}/gm
    ),
  ]
  if (interfaces.length !== 1) {
    throw new Error('Expected exactly one FileRoutesByFullPath interface')
  }
  const routes = []
  for (const line of interfaces[0][1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(
      /^\s*(['"])(\/[^'"]*)\1:\s*typeof\s+[A-Za-z_$][\w$]*[;,]?\s*$/
    )
    if (!match) throw new Error('Malformed FileRoutesByFullPath entry')
    const route = match[2]
    if (
      !/^\/(?:[A-Za-z0-9_$.-]+\/?)*$/.test(route) ||
      route.split('/').some((segment) => segment === '.' || segment === '..') ||
      routes.includes(route)
    ) {
      throw new Error(`Unsafe or duplicate route: ${route}`)
    }
    routes.push(route)
  }
  if (routes.length === 0) throw new Error('FileRoutesByFullPath is empty')
  return routes.sort()
}

export function generateRelease(options) {
  const releaseId = validateReleaseId(options.releaseId)
  if (
    typeof options.sourceRevision !== 'string' ||
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(options.sourceRevision)
  ) {
    throw new Error('Source revision must be a full Git SHA')
  }
  if (
    typeof options.version !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/.test(options.version) ||
    options.version
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid frontend version')
  }
  if (typeof options.dist !== 'string' || !options.dist) {
    throw new Error('A dist directory is required')
  }
  const dist = path.resolve(options.dist)
  const sourceRoot = options.webRoot || webRoot
  const files = artifactFiles(dist)
  if (
    !files.includes('index.html') ||
    readRegularFile(path.join(dist, 'index.html')).length === 0
  ) {
    throw new Error('dist must contain a non-empty index.html')
  }
  const routes = extractRoutes(
    readRegularFile(path.join(sourceRoot, 'src/routeTree.gen.ts')).toString(
      'utf8'
    )
  )
  const publicFiles = artifactFiles(path.join(sourceRoot, 'public')).filter(
    (file) => files.includes(file)
  )
  if (publicFiles.includes('release.json')) {
    throw new Error('public/release.json is reserved for the release manifest')
  }
  const manifest = {
    schema_version: 1,
    release_id: releaseId,
    asset_prefix: `/static/new-api/${releaseId}/`,
    source_revision: options.sourceRevision.toLowerCase(),
    frontend_version: options.version,
    routes,
    public_files: publicFiles,
    files: Object.fromEntries(
      files
        .filter((file) => file !== 'release.json')
        .map((file) => [
          file,
          createHash('sha256')
            .update(readRegularFile(path.join(dist, file)))
            .digest('hex'),
        ])
    ),
  }
  // 无时间戳或随机字段；重跑只接受完全相同的清单，绝不覆盖已有不同内容。
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestPath = path.join(dist, 'release.json')
  if (files.includes('release.json')) {
    if (readRegularFile(manifestPath).toString('utf8') !== content) {
      throw new Error(
        'Existing release.json differs; rebuild into a fresh dist'
      )
    }
  } else {
    writeFileSync(manifestPath, content, { flag: 'wx' })
  }
  return manifest
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        dist: { type: 'string' },
        'release-id': { type: 'string' },
        'source-revision': { type: 'string' },
        version: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    })
    for (const name of ['dist', 'release-id', 'source-revision', 'version']) {
      if (!values[name]) throw new Error(`Missing --${name}`)
    }
    generateRelease({
      dist: values.dist,
      releaseId: values['release-id'],
      sourceRevision: values['source-revision'],
      version: values.version,
    })
    console.log(`Generated ${path.join(values.dist, 'release.json')}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
