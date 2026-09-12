import type { SVGProps } from 'react'

/** The canonical Adea mark used by web, desktop, and dialogs. */
export function WorkspaceLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label="Adea" {...props}>
      <rect width="64" height="64" rx="16" className="fill-[var(--workspace-logo-surface)]" />
      <path
        d="M10 16h7v13h9V16h7v32h-7V36h-9v12h-7z"
        className="fill-[var(--workspace-logo-foreground)]"
      />
      <path
        d="M45 16c-7.18 0-13 6-13 16s5.82 16 13 16c7.18 0 13-6 13-16s-5.82-16-13-16Zm0 7c3.42 0 6 3.46 6 9s-2.58 9-6 9-6-3.46-6-9 2.58-9 6-9Z"
        fillRule="evenodd"
        className="fill-[var(--workspace-logo-foreground)]"
      />
      <path d="m45 35 11 11-4 4-11-11z" className="fill-[var(--workspace-logo-foreground)]" />
    </svg>
  )
}
