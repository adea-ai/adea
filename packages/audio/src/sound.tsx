import { Music, Music2 } from 'lucide-solid'
import {
  createContext,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  createEffect,
  useContext,
  type ParentProps,
} from 'solid-js'
import { soundController, type MusicOptions } from './controller'
import { musicForScene } from './scene-music'
import type { MusicId } from './config'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

export type SoundContextValue = {
  controller: typeof soundController
  ready: boolean
  musicMuted: boolean
  toggleMusicMute: () => void
  playMusic: (id: MusicId, options?: MusicOptions) => void
}

const SoundContext = createContext<SoundContextValue | null>(null)

export function SoundProvider(props: ParentProps) {
  const [musicMuted, setMusicMuted] = createSignal(false)
  const [ready, setReady] = createSignal(false)

  onMount(() => {
    let mounted = true
    queueMicrotask(() => {
      if (mounted) setMusicMuted(soundController.musicMuted)
    })

    const onGesture = () => {
      void soundController.unlock().then(() => {
        if (mounted) setReady(true)
      })
    }
    window.addEventListener('pointerdown', onGesture, { capture: true })
    window.addEventListener('keydown', onGesture, { capture: true })
    window.addEventListener('touchstart', onGesture, { capture: true })
    if (new URLSearchParams(window.location.search).has('debug')) {
      ;(window as unknown as { __agentHqSound?: typeof soundController }).__agentHqSound =
        soundController
    }
    onCleanup(() => {
      mounted = false
      window.removeEventListener('pointerdown', onGesture, { capture: true })
      window.removeEventListener('keydown', onGesture, { capture: true })
      window.removeEventListener('touchstart', onGesture, { capture: true })
    })
  })

  const value = createMemo<SoundContextValue>(() => ({
    controller: soundController,
    ready: ready(),
    musicMuted: musicMuted(),
    toggleMusicMute: () => setMusicMuted(soundController.toggleMusicMute()),
    playMusic: (id, options) => soundController.playMusic(id, options),
  }))

  return <SoundContext.Provider value={value()}>{props.children}</SoundContext.Provider>
}

export function useSound(): SoundContextValue {
  const value = useContext(SoundContext)
  if (!value) throw new Error('useSound must be used within <SoundProvider>')
  return value
}

/**
 * The sound context when one exists, `null` otherwise. Hosts that render
 * shared components outside a `<SoundProvider>` (tests, alternate shells, a
 * dialog tree mounted before the app providers) read this instead of letting
 * `useSound`'s guard throw during render and tear down the whole host tree —
 * the settings dialog's soundtrack row white-screened the app that way when
 * the "Input & notifications" section mounted `<MusicToggle />` unprovided.
 */
export function useOptionalSound(): SoundContextValue | null {
  return useContext(SoundContext)
}

export function useSceneMusic(sceneId: string | null | undefined): void {
  createEffect(
    on(
      () => sceneId,
      (scene) => {
        const timeout = window.setTimeout(() => {
          soundController.playMusic(musicForScene(scene))
        }, 1500)
        onCleanup(() => window.clearTimeout(timeout))
      }
    )
  )
}

function MusicButton(props: { muted: boolean; onToggle: () => void }) {
  return (
    <ActionButton
      type="button"
      tooltip={props.muted ? 'Unmute music' : 'Mute music'}
      aria-label={props.muted ? 'Unmute music' : 'Mute music'}
      aria-pressed={props.muted}
      onClick={() => props.onToggle()}
      variant={props.muted ? 'outline' : 'default'}
      size="icon-lg"
    >
      {props.muted ? (
        <Music class="size-5" aria-hidden="true" />
      ) : (
        <Music2 class="size-5" aria-hidden="true" />
      )}
    </ActionButton>
  )
}

export function MusicToggle() {
  const context = useOptionalSound()
  if (context) {
    return <MusicButton muted={context.musicMuted} onToggle={context.toggleMusicMute} />
  }
  // No provider: drive the singleton controller directly so the control stays
  // honest and operable instead of throwing during render. The mute state
  // lives on the controller, so the button only needs to mirror it.
  const [unprovidedMuted, setUnprovidedMuted] = createSignal(soundController.musicMuted)
  return (
    <MusicButton
      muted={unprovidedMuted()}
      onToggle={() => setUnprovidedMuted(soundController.toggleMusicMute())}
    />
  )
}
