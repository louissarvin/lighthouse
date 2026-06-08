import { Link, useRouter } from '@tanstack/react-router'
import { motion } from 'motion/react'
import { RefreshCw } from 'lucide-react'
import { cnm } from '@/utils/style'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'

interface ErrorPageProps {
  error?: Error
  reset?: () => void
}

function is404(error?: Error): boolean {
  if (!error) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('404') ||
    msg.includes('not found') ||
    error.name === 'NotFoundError'
  )
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  const router = useRouter()

  if (is404(error)) {
    return (
      <div className="min-h-screen bg-lh-bg flex flex-col">
        <PillNav />

        <main className="flex-1 flex items-center justify-center min-h-[60vh] px-4 sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="w-full max-w-[540px]"
          >
            <EyebrowTag dot className="mb-4">
              404 / ROUTE NOT FOUND
            </EyebrowTag>

            <h1
              className={cnm(
                'font-bold tracking-[-1px] text-lh-text leading-tight',
                'text-[32px] sm:text-[48px]',
                'mb-4',
              )}
            >
              This route is dark.
            </h1>

            <p
              className={cnm(
                'text-[24px] font-medium text-lh-text-dim leading-snug',
                'mb-6',
              )}
            >
              The lighthouse cannot see it.
            </p>

            <p className="text-[16px] font-normal text-lh-text-dim leading-relaxed max-w-[540px] mb-10">
              The page you requested does not exist in this build. If you
              reached this from a link, the link is stale. If you typed the URL,
              double-check the spelling.
            </p>

            <Link
              to="/"
              className={cnm(
                'inline-flex items-center text-sm font-semibold text-lh-text-dim',
                'bg-transparent rounded-none px-0',
                'hover:text-lh-text',
                'relative after:absolute after:bottom-0 after:left-0',
                'after:h-px after:w-0 after:bg-lh-accent-warm',
                'after:transition-[width] after:duration-200',
                'hover:after:w-full',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
                'transition-colors duration-150',
              )}
            >
              Back to home
            </Link>
          </motion.div>
        </main>

        <FooterCard />
      </div>
    )
  }

  // Generic runtime error path — reset() flow preserved
  const handleRetry = () => {
    if (reset) {
      reset()
    } else {
      router.invalidate()
    }
  }

  return (
    <div className="min-h-screen bg-lh-bg flex flex-col">
      <PillNav />

      <main className="flex-1 flex items-center justify-center min-h-[60vh] px-4 sm:px-6">
        <div className="w-full max-w-[540px]">
          <EyebrowTag dot className="mb-4">
            ERROR / UNEXPECTED
          </EyebrowTag>

          <h1
            className={cnm(
              'font-bold tracking-[-1px] text-lh-text leading-tight',
              'text-[32px] sm:text-[48px]',
              'mb-4',
            )}
          >
            Something went wrong.
          </h1>

          <p className="text-[16px] text-lh-text-dim leading-relaxed mb-8">
            An unexpected error occurred. Try again or return home.
          </p>

          {error && (
            <div className="mb-8 px-4 py-3 bg-lh-bg-elev border border-lh-line rounded-lg">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-1">
                Details
              </p>
              {/* React JSX text escapes this automatically — no XSS risk */}
              <p className="font-mono text-xs text-lh-text-dim break-all">
                {error.message || 'Unknown error'}
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-start gap-4">
            <button
              onClick={handleRetry}
              className={cnm(
                'inline-flex items-center gap-2 px-6 py-3 rounded-full',
                'text-sm font-semibold',
                'bg-lh-accent text-lh-bg',
                'hover:bg-lh-accent-warm',
                'transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
              )}
            >
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
              Try again
            </button>

            <Link
              to="/"
              className={cnm(
                'inline-flex items-center text-sm font-semibold text-lh-text-dim',
                'bg-transparent rounded-none px-0 py-3',
                'hover:text-lh-text',
                'relative after:absolute after:bottom-0 after:left-0',
                'after:h-px after:w-0 after:bg-lh-accent-warm',
                'after:transition-[width] after:duration-200',
                'hover:after:w-full',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
                'transition-colors duration-150',
              )}
            >
              Back to home
            </Link>
          </div>
        </div>
      </main>

      <FooterCard />
    </div>
  )
}
