import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'

import { codexPluginLogoUrls } from './codex-plugin-marketplace.generated'

export function PluginLogo({ iconKey, name }: Readonly<{ iconKey: string; name: string }>) {
  const [failed, setFailed] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const source = iconKey.startsWith('codex:')
    ? codexPluginLogoUrls[iconKey.slice('codex:'.length)]
    : undefined
  const clearFallbackTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  useEffect(() => {
    setFailed(false)
    clearFallbackTimer()
    if (source) {
      timeoutRef.current = setTimeout(() => setFailed(true), 5_000)
    }
    return clearFallbackTimer
  }, [source])

  return (
    <span aria-hidden="true" className="plugin-logo" data-plugin-name={name}>
      {source && !failed ? (
        <img
          alt=""
          src={source}
          onError={() => {
            clearFallbackTimer()
            setFailed(true)
          }}
          onLoad={clearFallbackTimer}
        />
      ) : (
        <Sparkles />
      )}
    </span>
  )
}
