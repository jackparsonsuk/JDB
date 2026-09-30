import { useId } from 'react'
import { APP_NAME } from '@shared/brand'

/**
 * The OverlookDB mark: an O with a horizon across it and a sun rising inside, on a green tile.
 * scripts/make-icon.cjs draws the same shapes for the app icon; keep the two in step.
 */
export function LogoMark({ size = 20 }: { size?: number }) {
  const id = useId()
  // Below ~20px the sun turns to mush, so small marks are the ring and horizon only.
  const small = size < 20
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4cc764" />
          <stop offset="1" stopColor="#1f7a33" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill={`url(#${id}-tile)`} />
      {/* The sun, half risen above the horizon. */}
      {!small && <path d="M36 60 A14 14 0 0 1 64 60 Z" fill="#fff" />}
      <circle cx="50" cy="50" r="28" fill="none" stroke="#fff" strokeWidth={small ? 11 : 9} />
      <line x1="12" y1="60" x2="88" y2="60" stroke="#fff" strokeWidth={small ? 10 : 7} strokeLinecap="round" />
    </svg>
  )
}

/** The mark and the name, as the sidebar header and welcome screen show them. */
export function Logo({ size = 20, className = '' }: { size?: number; className?: string }) {
  const [main, suffix] = APP_NAME.endsWith('DB') ? [APP_NAME.slice(0, -2), 'DB'] : [APP_NAME, '']
  return (
    <span className={`logo ${className}`}>
      <LogoMark size={size} />
      <span className="logo-name">{main}{suffix && <span className="logo-suffix">{suffix}</span>}</span>
    </span>
  )
}
