import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cnm } from '@/utils/style'

interface MobileNavDrawerProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}

export function MobileNavDrawer({
  open,
  onClose,
  children,
}: MobileNavDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const first = drawerRef.current?.querySelector<HTMLElement>(
      'a, button, input, [tabindex]:not([tabindex="-1"])',
    )
    first?.focus()
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="fixed inset-0 z-[50] bg-lh-bg/80 backdrop-blur-md"
            aria-hidden="true"
            onClick={onClose}
          />
          <motion.div
            key="drawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{
              duration: 0.3,
              ease: [0.22, 1, 0.36, 1],
            }}
            className={cnm(
              'fixed left-0 top-0 bottom-0 z-[50]',
              'w-[280px] bg-lh-bg border-r border-lh-line',
              'flex flex-col p-6',
            )}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
