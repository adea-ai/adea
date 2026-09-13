import { Sparkles } from 'lucide-solid'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

export function PluginLogo(props: { iconKey?: string; iconUrl?: string; name: string }) {
  const [failed, setFailed] = createSignal(false)
  let timeout: ReturnType<typeof setTimeout> | null = null
  const source = () => safeIconUrl(props.iconUrl)
  const clearFallbackTimer = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  createEffect(() => {
    const current = source()
    setFailed(false)
    clearFallbackTimer()
    if (current) {
      timeout = setTimeout(() => setFailed(true), 5_000)
    }
    onCleanup(clearFallbackTimer)
  })

  return (
    <span aria-hidden="true" class="plugin-logo" data-plugin-name={props.name}>
      <Show
        when={source() && !failed()}
        fallback={<span class="plugin-logo__fallback">{initials(props.name) || <Sparkles />}</span>}
      >
        <img
          alt=""
          src={source()}
          onError={() => {
            clearFallbackTimer()
            setFailed(true)
          }}
          onLoad={clearFallbackTimer}
        />
      </Show>
    </span>
  )
}

function safeIconUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '')
    .join('')
}
