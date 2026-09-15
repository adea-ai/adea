import {
  Check,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-solid'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'

import { formatReleaseDate, plainTextFromMarkdown } from '#lib/version-notes'
import { Button, buttonVariants } from '#components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#components/ui/dialog'

export type SharedDesktopUpdate = Readonly<{
  available_version: string | null
  changelog: string
  current_version: string
  downloaded_bytes: number
  error: string | null
  github_url: string
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'installing'
    | 'installed'
    | 'failed'
  release_date: string | null
  release_notes: string | null
  restart_required: boolean
  total_bytes: number | null
}>

export type VersionDialogAdapter = Readonly<{
  check(): Promise<SharedDesktopUpdate>
  getStatus(): Promise<SharedDesktopUpdate>
  install(expectedVersion: string): Promise<SharedDesktopUpdate>
  isDesktopRuntime(): boolean
}>

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message) return caught.message
  if (typeof caught === 'string' && caught) return caught
  return fallback
}

function phaseLabel(update: SharedDesktopUpdate | null, fallbackVersion: string): string {
  if (!update) return `Adea v${fallbackVersion}`
  if (update.phase === 'checking') return 'Checking for updates…'
  if (update.phase === 'available' && update.available_version) {
    return `Update v${update.available_version} available`
  }
  if (update.phase === 'downloading' || update.phase === 'installing') {
    return 'Installing update…'
  }
  if (update.phase === 'failed') return `Version ${update.current_version} · Retry`
  return `Adea v${update.current_version || fallbackVersion}`
}

function isUpdateBusy(update: SharedDesktopUpdate | null): boolean {
  return (
    update?.phase === 'checking' ||
    update?.phase === 'downloading' ||
    update?.phase === 'installing'
  )
}

export function VersionDialog(props: {
  adapter: VersionDialogAdapter
  fallbackVersion?: string
  onOpenChange?: (open: boolean) => void
  open?: boolean
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = createSignal(false)
  const open = () => props.open ?? uncontrolledOpen()
  const setOpen = (nextOpen: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(nextOpen)
    props.onOpenChange?.(nextOpen)
  }

  const [desktopRuntime, setDesktopRuntime] = createSignal(false)
  const [update, setUpdate] = createSignal<SharedDesktopUpdate | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  const loadCurrentStatus = async () => {
    if (!desktopRuntime()) return
    try {
      setUpdate(await props.adapter.getStatus())
    } catch (caught) {
      setError(errorMessage(caught, 'Version status is unavailable'))
    }
  }

  createEffect(() => setDesktopRuntime(props.adapter.isDesktopRuntime()))

  createEffect(() => {
    if (desktopRuntime()) void loadCurrentStatus()
  })

  const checkForUpdates = async () => {
    if (!desktopRuntime()) {
      setError('Update checks are available from the desktop app.')
      return
    }
    setBusy(true)
    setError('')
    try {
      setUpdate(await props.adapter.check())
    } catch (caught) {
      setError(errorMessage(caught, 'Could not check for updates'))
      await loadCurrentStatus()
    } finally {
      setBusy(false)
    }
  }

  createEffect(() => {
    if (!open() || !desktopRuntime()) return
    let active = true
    setError('')
    setBusy(true)
    void (async () => {
      try {
        const current = await props.adapter.getStatus()
        if (!active) return
        setUpdate(current)
        const checked = await props.adapter.check()
        if (active) setUpdate(checked)
      } catch (caught) {
        if (active) setError(errorMessage(caught, 'Could not check for updates'))
      } finally {
        if (active) setBusy(false)
      }
    })()
    return () => {
      active = false
    }
  })

  const install = async () => {
    const version = update()?.available_version
    if (!version) return
    setBusy(true)
    setError('')
    try {
      const next = await props.adapter.install(version)
      setUpdate(next)
      // A refused install answers with a normal status payload whose phase is
      // `failed` (the shell's download/extract/apply errors). Without this,
      // clicking install looked like nothing happened at all.
      if (next.phase === 'failed') {
        setError(errorMessage(next.error, 'Update installation failed'))
      }
    } catch (caught) {
      setError(errorMessage(caught, 'Update installation failed'))
      await loadCurrentStatus()
    } finally {
      setBusy(false)
    }
  }

  const currentChangelog = createMemo(() =>
    plainTextFromMarkdown(update()?.changelog || 'Changelog is loading…')
  )
  const releaseNotes = () => {
    const notes = update()?.release_notes
    return notes ? plainTextFromMarkdown(notes) : ''
  }
  const busyFromSnapshot = () => isUpdateBusy(update())

  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <Show when={props.open === undefined}>
        <DialogTrigger
          class={buttonVariants({ variant: 'ghost', size: 'sm' })}
          aria-label="Open version and updates dialog"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Show when={update()?.phase === 'available'} fallback={<FileText aria-hidden="true" />}>
            <Sparkles aria-hidden="true" />
          </Show>
          {phaseLabel(update(), props.fallbackVersion ?? '0.1.0')}
        </DialogTrigger>
      </Show>

      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <div class="flex items-center gap-3">
            <span class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Sparkles class="size-5" aria-hidden="true" />
            </span>
            <div>
              <DialogTitle>Version & updates</DialogTitle>
              <DialogDescription>
                Keep Adea current and review what changed in each release.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div class="flex min-h-0 flex-col gap-5 overflow-y-auto p-6">
          <section class="rounded-xl border bg-background/45 p-4" aria-label="Version status">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="flex flex-col gap-1">
                <p class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Installed version
                </p>
                <p class="text-xl font-semibold tracking-tight">
                  v{update()?.current_version || props.fallbackVersion || '0.1.0'}
                </p>
                <p class="text-sm text-muted-foreground">
                  <Show
                    when={update()?.phase === 'current'}
                    fallback={
                      <Show
                        when={update()?.phase === 'available' && update()?.available_version}
                        fallback={
                          desktopRuntime()
                            ? 'Check the release channel for the latest signed build.'
                            : 'Open this dialog inside the desktop app to check for updates.'
                        }
                      >
                        {`A newer desktop release, v${update()?.available_version}, is ready.`}
                      </Show>
                    }
                  >
                    You are running the latest desktop release.
                  </Show>
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!desktopRuntime() || busy() || busyFromSnapshot()}
                onClick={() => void checkForUpdates()}
              >
                <Show
                  when={busy() || busyFromSnapshot()}
                  fallback={<RefreshCw aria-hidden="true" />}
                >
                  <LoaderCircle class="animate-spin" aria-hidden="true" />
                </Show>
                Check latest version
              </Button>
            </div>
          </section>

          <Show when={update()?.phase === 'available' && update()?.available_version}>
            <section
              class="rounded-xl border border-primary/35 bg-primary/8 p-4"
              aria-label="Available update"
            >
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="flex flex-col gap-1">
                  <p class="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles class="size-4 text-primary" aria-hidden="true" />
                    Version {update()?.available_version} is ready
                  </p>
                  <p class="text-sm text-muted-foreground">
                    The signed installer will be verified before Adea restarts.
                  </p>
                  <Show when={formatReleaseDate(update()?.release_date ?? null)}>
                    {(released) => (
                      <p class="text-xs text-muted-foreground">Released {released()}</p>
                    )}
                  </Show>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy() || busyFromSnapshot()}
                  onClick={() => void install()}
                >
                  <Show
                    when={busy() || busyFromSnapshot()}
                    fallback={<Download aria-hidden="true" />}
                  >
                    <LoaderCircle class="animate-spin" aria-hidden="true" />
                  </Show>
                  Install and restart
                </Button>
              </div>
            </section>
          </Show>

          <Show when={update()?.phase === 'current'}>
            <p class="flex items-center gap-2 text-sm text-success" role="status">
              <Check class="size-4" aria-hidden="true" />
              Adea is up to date.
            </p>
          </Show>

          <Show when={error()}>
            <p
              class="rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error()}
            </p>
          </Show>

          <Show when={releaseNotes()}>
            <section class="flex flex-col gap-2" aria-labelledby="adea-release-notes">
              <div>
                <h2 id="adea-release-notes" class="text-sm font-semibold">
                  What changed in this release
                </h2>
                <p class="text-xs text-muted-foreground">
                  Release notes are shown as readable text.
                </p>
              </div>
              <div class="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-background/45 p-4 font-mono text-xs leading-5 text-muted-foreground">
                {releaseNotes()}
              </div>
            </section>
          </Show>

          <section class="flex flex-col gap-2" aria-labelledby="agent-hq-changelog">
            <div>
              <h2 id="agent-hq-changelog" class="text-sm font-semibold">
                Installed changelog
              </h2>
              <p class="text-xs text-muted-foreground">
                A plain-text history of the installed channel.
              </p>
            </div>
            <div class="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-background/45 p-4 font-mono text-xs leading-5 text-muted-foreground">
              {currentChangelog()}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Show when={update()?.github_url}>
            {(githubUrl) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => window.open(githubUrl(), '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink aria-hidden="true" />
                View releases
              </Button>
            )}
          </Show>
          <DialogClose class={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
