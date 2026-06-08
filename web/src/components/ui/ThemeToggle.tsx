import { AnimatePresence, motion } from 'motion/react'
import { Moon, Sun } from 'lucide-react'
import { cnm } from '@/utils/style'
import { useTheme } from '@/providers/ThemeProvider'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    toggleTheme(e)
  }

  return (
    <button
      onClick={handleClick}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cnm(
        'w-8 h-8 flex items-center justify-center rounded-full',
        'text-lh-text-dim hover:text-lh-text',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={isDark ? 'moon' : 'sun'}
          initial={{ opacity: 0, rotate: -30, scale: 0.7 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 30, scale: 0.7 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
        >
          {isDark ? (
            <Moon size={16} strokeWidth={1.5} />
          ) : (
            <Sun size={16} strokeWidth={1.5} />
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  )
}
