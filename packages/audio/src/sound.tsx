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
    <button
      type="button"
      aria-label={props.muted ? 'Unmute music' : 'Mute music'}
      aria-pressed={props.muted}
      onClick={() => props.onToggle()}
      class={`inline-flex size-9 items-center justify-center rounded-lg border border-input bg-background transition-colors ${props.muted ? 'text-muted-foreground hover:text-foreground' : 'bg-primary text-primary-foreground'}`}
    >
      {props.muted ? (
        <Music class="size-5" aria-hidden="true" />
      ) : (
        <Music2 class="size-5" aria-hidden="true" />
      )}
    </button>
  )
}

export function MusicToggle() {
  const { musicMuted, toggleMusicMute } = useSound()
  return <MusicButton muted={musicMuted} onToggle={toggleMusicMute} />
}
