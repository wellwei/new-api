import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv, type HtmlTag } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss'
import { tanstackRouter } from '@tanstack/router-plugin/rspack'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveExistingAncestor(target: string): string {
  let ancestor = path.resolve(target)
  const missingSegments: string[] = []
  while (true) {
    try {
      const metadata = lstatSync(ancestor)
      if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new Error('NEW_API_WEB_DIST must resolve to a directory')
      }
      break
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw new Error(
          'Invalid NEW_API_WEB_DIST: cannot inspect its existing ancestor'
        )
      }
      missingSegments.unshift(path.basename(ancestor))
      const parent = path.dirname(ancestor)
      if (parent === ancestor) {
        throw new Error('Invalid NEW_API_WEB_DIST: no existing ancestor')
      }
      ancestor = parent
    }
  }
  // 未创建的目录也要解析最近现存祖先；断链符号链接在此失败，不能当作安全缺失目录。
  try {
    const resolvedAncestor = realpathSync(ancestor)
    if (!lstatSync(resolvedAncestor).isDirectory()) {
      throw new Error('NEW_API_WEB_DIST must resolve to a directory')
    }
    return path.join(resolvedAncestor, ...missingSegments)
  } catch {
    throw new Error(
      'Invalid NEW_API_WEB_DIST: cannot resolve its existing ancestor'
    )
  }
}

function pathContains(parent: string, target: string): boolean {
  const relative = path.relative(parent, target)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function releaseAnalyticsTags(env: NodeJS.ProcessEnv): HtmlTag[] {
  const tags: HtmlTag[] = []
  const websiteId = env.UMAMI_WEBSITE_ID
  const scriptUrl = env.UMAMI_SCRIPT_URL
  const analyticsId = env.GOOGLE_ANALYTICS_ID

  if (websiteId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(websiteId)) {
    throw new Error('Invalid UMAMI_WEBSITE_ID')
  }

  if (websiteId || scriptUrl) {
    const url = new URL(scriptUrl || 'https://analytics.umami.is/script.js')
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      /[\s<>"'\\]/.test(scriptUrl || '')
    ) {
      throw new Error('UMAMI_SCRIPT_URL must be an absolute HTTPS URL')
    }
    if (websiteId) {
      tags.push({
        tag: 'script',
        attrs: {
          defer: true,
          // Rsbuild 的标签属性直接拼接 HTML，因此查询参数中的 & 也必须转义。
          src: url.href.replaceAll('&', '&amp;'),
          'data-website-id': websiteId,
        },
        publicPath: false,
        head: true,
      })
    }
  }

  if (analyticsId) {
    if (!/^(?:G-[A-Z0-9]{1,32}|UA-[0-9]{1,16}-[0-9]{1,4})$/.test(analyticsId)) {
      throw new Error('Invalid GOOGLE_ANALYTICS_ID')
    }
    tags.push(
      {
        tag: 'script',
        attrs: {
          async: true,
          src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsId)}`,
        },
        publicPath: false,
        head: true,
      },
      {
        tag: 'script',
        // 只注入白名单公开配置；JSON 字符串编码与 ID 校验共同阻止脚本闭合注入。
        children: `window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', ${JSON.stringify(analyticsId)});`,
        head: true,
      }
    )
  }

  return tags
}

export default defineConfig(({ envMode }) => {
  const env = loadEnv({ mode: envMode, prefixes: ['VITE_'] })
  const serverUrl =
    process.env.VITE_REACT_APP_SERVER_URL ||
    env.rawPublicVars.VITE_REACT_APP_SERVER_URL ||
    'http://localhost:3000'

  const isProd = envMode === 'production'
  const releaseId = process.env.NEW_API_WEB_RELEASE_ID
  if (
    releaseId !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) ||
      releaseId === '.' ||
      releaseId === '..')
  ) {
    throw new Error('Invalid NEW_API_WEB_RELEASE_ID')
  }
  // 未指定发布 ID 时完全沿用 embedded 构建；分析配置仍由 Go 注入。
  const releaseHtml =
    releaseId === undefined ? {} : { tags: releaseAnalyticsTags(process.env) }
  const releaseDist =
    releaseId === undefined ? undefined : process.env.NEW_API_WEB_DIST
  if (
    releaseDist !== undefined &&
    (!releaseDist || releaseDist.includes('\0'))
  ) {
    throw new Error('Invalid NEW_API_WEB_DIST')
  }
  let distRoot =
    releaseDist === undefined ? 'dist' : path.resolve(__dirname, releaseDist)
  if (releaseId !== undefined) {
    const lexicalRoot = path.resolve(__dirname, distRoot)
    const resolvedRoot = resolveExistingAncestor(lexicalRoot)
    const protectedDirectories = [
      'src',
      'public',
      'scripts',
      'node_modules',
    ].map((directory) => path.join(__dirname, directory))
    const sourceRoot = path.dirname(__dirname)
    // 仓库现存兄弟目录均属于源码，包括隐藏目录及目录链接；无需调用 Git。
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (entry.name === path.basename(__dirname)) continue
      const sibling = path.join(sourceRoot, entry.name)
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && statSync(sibling).isDirectory())
      ) {
        protectedDirectories.push(sibling)
      }
    }
    const protectedPaths = protectedDirectories.flatMap((protectedPath) => [
      protectedPath,
      resolveExistingAncestor(protectedPath),
    ])
    // 构建器会清空输出目录：词法路径和真实路径均不可覆盖源码、依赖或它们的父子目录。
    for (const outputRoot of [lexicalRoot, resolvedRoot]) {
      if (
        [__dirname, realpathSync(__dirname)].some((root) =>
          pathContains(outputRoot, root)
        ) ||
        protectedPaths.some(
          (protectedPath) =>
            pathContains(outputRoot, protectedPath) ||
            pathContains(protectedPath, outputRoot)
        )
      ) {
        throw new Error(
          'NEW_API_WEB_DIST overlaps a protected source directory'
        )
      }
    }
    if (releaseDist !== undefined) distRoot = resolvedRoot
  }
  const devProxy = Object.fromEntries(
    (['/api', '/v1', '/mj', '/pg'] as const).map((key) => [
      key,
      { target: serverUrl, changeOrigin: true },
    ])
  ) as Record<string, { target: string; changeOrigin: boolean }>

  return {
    plugins: [pluginReact(), pluginTailwindcss({ optimize: false })],
    // Rsbuild 2: replaces deprecated `performance.chunkSplit` (RSPack 2 aligned)
    splitChunks: {
      preset: 'default',
      cacheGroups: {
        'vendor-react': {
          test: /node_modules[\\/](react|react-dom)[\\/]/,
          name: 'vendor-react',
          chunks: 'all',
          priority: 0,
          enforce: true,
        },
        'vendor-ui-primitives': {
          test: /node_modules[\\/](@base-ui|@radix-ui)[\\/]/,
          name: 'vendor-ui-primitives',
          chunks: 'all',
          priority: 0,
          enforce: true,
        },
        'vendor-tanstack': {
          test: /node_modules[\\/]@tanstack[\\/]/,
          name: 'vendor-tanstack',
          chunks: 'all',
          priority: 0,
          enforce: true,
        },
      },
    },
    source: {
      entry: {
        index: './src/main.tsx',
      },
      // The console's own documentation ships as markdown and is imported with
      // `?raw` (see features/explore/wiki). `.md` is not a default static asset
      // type, so it must be declared here or the import resolves to nothing.
      assetsInclude: /\.md$/,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    html: {
      template: './index.html',
      favicon: './public/favicon.ico',
      ...releaseHtml,
    },
    server: {
      host: '0.0.0.0',
      strictPort: false,
      proxy: devProxy,
    },
    output: {
      ...(releaseId === undefined
        ? {}
        : { assetPrefix: `/static/new-api/${releaseId}/` }),
      // Production optimizations
      minify: isProd,
      target: 'web',
      distPath: {
        // split 产物独立落盘，不覆盖 Go 默认嵌入的 web/dist。
        root: distRoot,
      },
      // Rely on Rsbuild default legalComments ("linked" → per-chunk *.LICENSE.txt) in all modes.
      // Do not set "none" in production: that strips minifier-preserved third-party notices and
      // extracted license files, which some distributions require for open-source compliance.
    },
    performance: {
      // Remove console in production
      removeConsole: isProd ? ['log'] : false,
      buildCache: false,
    },
    tools: {
      rspack: {
        plugins: [
          tanstackRouter({
            target: 'react',
            // Dev: avoid per-route async chunks (reduces white flash on navigation + faster HMR feedback).
            // Prod: keep route-based code splitting.
            autoCodeSplitting: isProd,
          }),
        ],
      },
    },
  }
})
