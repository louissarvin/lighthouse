import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import remarkGfm from 'remark-gfm'

// Walrus Sites hosts static blobs only — no Nitro/SSR runtime. Flip SPA mode
// for Walrus deploy builds (`WALRUS_SPA=1`) so site-builder gets index.html.
const walrusSpa =
  process.env.WALRUS_SPA === '1' || process.env.WALRUS_SPA === 'true'

const config = defineConfig({
  plugins: [
    devtools(),
    // Nitro SSR is incompatible with Walrus static hosting; skip for SPA builds.
    ...(walrusSpa ? [] : [nitro()]),
    // MDX must come before React so React can process the JSX output
    {
      enforce: 'pre',
      ...mdx({
        jsxImportSource: 'react',
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: 'frontmatter' }],
          remarkGfm,
        ],
      }),
    },
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(
      walrusSpa
        ? {
            spa: {
              enabled: true,
              prerender: {
                outputPath: '/index.html',
              },
            },
          }
        : undefined,
    ),
    viteReact({ include: /\.(jsx|tsx)$/ }),
  ],
})

export default config
