import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/lib/theme'

/**
 * Ghost icon button that flips light/dark. A single control, no filled fill —
 * the top bar keeps exactly one primary action (Upload). Shows the icon of the
 * mode it switches TO (moon while light, sun while dark).
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslation()
  const isDark = theme === 'dark'
  const label = isDark
    ? t('header.themeLight', { defaultValue: 'Switch to light mode' })
    : t('header.themeDark', { defaultValue: 'Switch to dark mode' })

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="flex size-9 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {isDark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  )
}
