import '../styles/baize-logo.css'

/**
 * @param {"sm" | "md" | "lg"} size  sm = header (28px), md = home (40px),
 *   lg = 56px
 */
export default function BaizeLogo({ size = 'lg', className = '' }) {
  const mod = `baize-logo--${size === 'sm' || size === 'md' ? size : 'lg'}`
  return (
    <div
      className={['baize-logo', mod, className].filter(Boolean).join(' ')}
      aria-hidden='true'
    >
      B
    </div>
  )
}
