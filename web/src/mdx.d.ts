// Type declarations for *.mdx module imports.
// The @mdx-js/rollup plugin compiles MDX files into React components.
// Frontmatter is exposed as a named export by the remark-mdx-frontmatter plugin
// (or manually — depends on MDX config). We declare it as a known shape here
// so TypeScript accepts static imports of *.mdx files.
declare module '*.mdx' {
  import type React from 'react'

  interface TOCEntry {
    id: string
    text: string
    level: 2 | 3
  }

  interface MDXFrontmatter {
    title: string
    description: string
    section: string
    toc: Array<TOCEntry>
  }

  const MDXComponent: React.ComponentType
  export default MDXComponent
  export const frontmatter: MDXFrontmatter
}
