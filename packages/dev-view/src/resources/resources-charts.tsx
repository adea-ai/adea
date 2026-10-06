/*
 * Small SVG charts for the resources sheet. Geometry rides SVG attributes
 * (viewBox coordinates, not inline styles) and colour rides the
 * `dev-resources__*` hooks, so the theme tokens decide every hue.
 */
import { For, Show } from 'solid-js'
import { cn } from '@adea-ai/ui/lib/utils'

import { barSegments, sparklinePoints } from './resources-view-model'

export function Sparkline(props: {
  values: readonly number[]
  tone?: 'neutral' | 'warning' | 'cpu'
  label?: string
  width?: number
  height?: number
}) {
  const width = () => props.width ?? 72
  const height = () => props.height ?? 20
  return (
    <Show
      when={props.values.length > 0}
      fallback={
        <svg
          class="dev-resources__spark dev-resources__spark--empty"
          viewBox={`0 0 ${width()} ${height()}`}
          aria-hidden="true"
        >
          <line x1="0" y1={height() / 2} x2={width()} y2={height() / 2} />
        </svg>
      }
    >
      <svg
        class={cn('dev-resources__spark', {
          'dev-resources__spark--warning': props.tone === 'warning',
          'dev-resources__spark--cpu': props.tone === 'cpu',
        })}
        viewBox={`0 0 ${width()} ${height()}`}
        preserveAspectRatio="none"
        role={props.label ? 'img' : undefined}
        aria-label={props.label}
        aria-hidden={props.label ? undefined : 'true'}
      >
        <polyline points={sparklinePoints(props.values, width(), height())} />
      </svg>
    </Show>
  )
}

export type BarPart = Readonly<{
  value: number | undefined
  tone: 'adea' | 'elsewhere' | 'other' | 'free' | 'source' | 'build' | 'retained'
}>

/** A segmented bar; `label` names every part for assistive tech. */
export function SegmentBar(props: { parts: readonly BarPart[]; label: string }) {
  const layout = () => {
    const widths = barSegments(props.parts.map((part) => part.value))
    let x = 0
    return props.parts.map((part, index) => {
      const width = widths[index] ?? 0
      const segment = { tone: part.tone, x, width }
      x += width
      return segment
    })
  }
  return (
    <svg
      class="dev-resources__bar"
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <rect class="dev-resources__bar-track" x="0" y="0" width="100" height="8" rx="1.5" />
      <For each={layout()}>
        {(segment) => (
          <Show when={segment.width > 0}>
            <rect
              class={cn('dev-resources__bar-part', {
                'dev-resources__bar-part--adea': segment.tone === 'adea',
                'dev-resources__bar-part--elsewhere': segment.tone === 'elsewhere',
                'dev-resources__bar-part--other': segment.tone === 'other',
                'dev-resources__bar-part--free': segment.tone === 'free',
                'dev-resources__bar-part--source': segment.tone === 'source',
                'dev-resources__bar-part--build': segment.tone === 'build',
                'dev-resources__bar-part--retained': segment.tone === 'retained',
              })}
              x={segment.x}
              y="0"
              width={Math.max(0, segment.width - 0.4)}
              height="8"
              rx="1.5"
            />
          </Show>
        )}
      </For>
    </svg>
  )
}

/** A legend swatch matching a bar part. */
export function Swatch(props: { tone: BarPart['tone'] }) {
  return (
    <span
      aria-hidden="true"
      class={cn('dev-resources__swatch', {
        'dev-resources__bar-part--adea': props.tone === 'adea',
        'dev-resources__bar-part--elsewhere': props.tone === 'elsewhere',
        'dev-resources__bar-part--other': props.tone === 'other',
        'dev-resources__bar-part--free': props.tone === 'free',
        'dev-resources__bar-part--source': props.tone === 'source',
        'dev-resources__bar-part--build': props.tone === 'build',
        'dev-resources__bar-part--retained': props.tone === 'retained',
      })}
    />
  )
}
