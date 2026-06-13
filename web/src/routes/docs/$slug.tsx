import {
  Link,
  createFileRoute,
  notFound,
  useParams,
} from '@tanstack/react-router'
import type { DocMeta } from '@/lib/docs'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { getDocBySlug } from '@/lib/docs'

// The loader returns only JSON-serializable metadata.
// React.ComponentType cannot be serialized across the SSR boundary, so
// the Content component is resolved client-side via useParams + getDocBySlug.
export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }): DocMeta => {
    const doc = getDocBySlug(params.slug)
    if (!doc) throw notFound()
    return {
      slug: doc.slug,
      title: doc.title,
      description: doc.description,
      section: doc.section,
      toc: doc.toc,
    }
  },
  notFoundComponent: () => (
    <DocsLayout>
      <div className="py-24 text-center">
        <EyebrowTag className="mb-4">404 / NOT FOUND</EyebrowTag>
        <h1 className="text-3xl font-bold text-lh-text mb-4">Page not found</h1>
        <p className="text-lh-text-dim mb-8">
          This docs section does not exist yet or has moved.
        </p>
        <Link
          to="/docs/$slug"
          params={{ slug: 'overview' }}
          className="text-lh-accent-warm text-sm font-mono uppercase tracking-[0.12em]"
        >
          Back to docs
        </Link>
      </div>
    </DocsLayout>
  ),
  component: DocPage,
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.title} | Lighthouse Docs`
          : 'Lighthouse Docs',
      },
      { name: 'description', content: loaderData?.description ?? '' },
    ],
  }),
})

function DocPage() {
  const meta = Route.useLoaderData()
  const { slug } = useParams({ from: '/docs/$slug' })

  // Resolve the Content component on the client. getDocBySlug is synchronous
  // (static registry) so this is safe and has no loading state.
  const doc = getDocBySlug(slug)
  const Content = doc?.Content

  return (
    <DocsLayout section={meta.section} page={meta.title} toc={meta.toc}>
      <h1 className="text-[40px] font-bold leading-[1.2] tracking-[-0.5px] text-lh-text mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-lh-text-dim leading-[1.7] mb-10">
        {meta.description}
      </p>
      <div className="prose-docs">{Content && <Content />}</div>
    </DocsLayout>
  )
}
