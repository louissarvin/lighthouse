import type React from 'react'
// Static import map of all MDX files. Hand-maintained for simplicity (no glob).
import * as Audits from '@/docs/audits.mdx'
import * as Overview from '@/docs/overview.mdx'
import * as Quickstart from '@/docs/quickstart.mdx'
import * as SdkInstallation from '@/docs/sdk-installation.mdx'
import * as SealPolicies from '@/docs/seal-policies.mdx'
import * as WalrusIntegration from '@/docs/walrus-integration.mdx'

export interface TOCEntry {
  id: string
  text: string
  level: 2 | 3
}

export interface DocMeta {
  slug: string
  title: string
  description: string
  section: string
  toc: Array<TOCEntry>
}

export interface Doc extends DocMeta {
  Content: React.ComponentType
}

// The MDX plugin exposes frontmatter as a named export called `frontmatter`.
// Each MDX file's default export is the compiled React component.
const REGISTRY: Partial<
  Record<
    string,
    { default: React.ComponentType; frontmatter: Omit<DocMeta, 'slug'> }
  >
> = {
  overview: Overview as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
  quickstart: Quickstart as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
  'sdk-installation': SdkInstallation as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
  'walrus-integration': WalrusIntegration as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
  'seal-policies': SealPolicies as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
  audits: Audits as unknown as {
    default: React.ComponentType
    frontmatter: Omit<DocMeta, 'slug'>
  },
}

export function getDocBySlug(slug: string): Doc | null {
  const entry = REGISTRY[slug]
  if (!entry) return null
  return {
    ...entry.frontmatter,
    slug,
    Content: entry.default,
  }
}

export function getAllDocSlugs(): Array<string> {
  return Object.keys(REGISTRY)
}

export const DOCS_NAV_TREE = [
  {
    section: 'Getting Started',
    items: [
      { slug: 'overview', label: 'Overview' },
      { slug: 'quickstart', label: 'Quickstart' },
      { slug: 'sdk-installation', label: 'SDK Installation' },
    ],
  },
  {
    section: 'Walrus Integration',
    items: [{ slug: 'walrus-integration', label: 'Blob Writes & Quilt' }],
  },
  {
    section: 'SEAL Policies',
    items: [{ slug: 'seal-policies', label: 'Owner, Copy-Trader, Audits' }],
  },
  {
    section: 'Audits',
    items: [{ slug: 'audits', label: 'Contract Status' }],
  },
] as const

/**
 * Flat list of all doc slugs in nav order. Useful for prev/next navigation.
 */
export const DOCS_ORDERED_SLUGS: Array<string> = DOCS_NAV_TREE.flatMap((section) =>
  section.items.map((item) => item.slug),
)

/**
 * Get the previous and next docs for prev/next navigation links.
 */
export function getDocNeighbors(slug: string): {
  prev: Doc | null
  next: Doc | null
} {
  const idx = DOCS_ORDERED_SLUGS.indexOf(slug)
  const prevSlug = idx > 0 ? DOCS_ORDERED_SLUGS[idx - 1] : null
  const nextSlug = idx < DOCS_ORDERED_SLUGS.length - 1 ? DOCS_ORDERED_SLUGS[idx + 1] : null
  return {
    prev: prevSlug ? getDocBySlug(prevSlug) : null,
    next: nextSlug ? getDocBySlug(nextSlug) : null,
  }
}
