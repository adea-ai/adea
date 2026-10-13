import type { JSX } from 'solid-js'

/**
 * Inline copies of the three Lucide glyphs the export and restore rows draw. Importing them from
 * `lucide-solid` would give each its own client chunk, and the chunk-count budget has no room for
 * three single-icon files in the workspace details dialog.
 */
type IconProps = Readonly<{ class?: string }>

const Glyph = (props: IconProps & { children: JSX.Element }) => (
  <svg
    aria-hidden="true"
    class={props.class}
    fill="none"
    height="24"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    viewBox="0 0 24 24"
    width="24"
    xmlns="http://www.w3.org/2000/svg"
  >
    {props.children}
  </svg>
)

export const Download = (props: IconProps) => (
  <Glyph class={props.class}>
    <path d="M12 15V3" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
  </Glyph>
)

export const Upload = (props: IconProps) => (
  <Glyph class={props.class}>
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </Glyph>
)

export const FileText = (props: IconProps) => (
  <Glyph class={props.class}>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </Glyph>
)
