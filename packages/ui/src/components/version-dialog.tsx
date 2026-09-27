import {
  Check,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-solid'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'

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

function messageText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const message = value.trim()
  return message && message !== '[object Object]' ? message : undefined
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error) return messageText(caught.message) ?? fallback
  const plainMessage = messageText(caught)
  if (plainMessage) return plainMessage
  if (!caught || typeof caught !== 'object') return fallback

  const record = caught as { error?: unknown; safe?: unknown }
  const safe = record.safe as { message?: unknown } | null | undefined
  const nestedError = record.error as { safe?: { message?: unknown } | null } | null | undefined
  return messageText(safe?.message) ?? messageText(nestedError?.safe?.message) ?? fallback
}

function phaseLabel(
  update: SharedDesktopUpdate | null,
  fallbackVersion: string,
  checkFailed: boolean
): string {
  if (checkFailed) return `Version ${update?.current_version || fallbackVersion} · Retry`
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

  const desktopRuntime = () => props.adapter.isDesktopRuntime()
  const [update, setUpdate] = createSignal<SharedDesktopUpdate | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [checkFailed, setCheckFailed] = createSignal(false)
  let checkGeneration = 0

  const failCheck = (caught: unknown, fallback: string) => {
    const message = errorMessage(caught, fallback)
    setCheckFailed(true)
    setError(message)
  }

  const applyCheckResult = (next: SharedDesktopUpdate) => {
    if (next.phase === 'failed') {
      if (!update()) setUpdate(next)
      failCheck(next.error, 'Could not check for updates')
      return
    }
    setUpdate(next)
    setCheckFailed(false)
    setError('')
  }

  const loadCurrentStatus = async (generation = checkGeneration) => {
    if (!desktopRuntime()) return
    try {
      const current = await props.adapter.getStatus()
      const previous = update()
      const previousHasActionableSnapshot =
        previous?.phase === 'available' || isUpdateBusy(previous)
      const preservesSnapshot =
        previous?.phase === 'available'
          ? current.phase === 'available' || isUpdateBusy(current)
          : isUpdateBusy(previous) && isUpdateBusy(current)
      const wouldDiscardActionableSnapshot =
        checkFailed() && previousHasActionableSnapshot && !preservesSnapshot
      if (
        generation !== checkGeneration ||
        previous?.phase === 'checking' ||
        wouldDiscardActionableSnapshot
      ) {
        return
      }
      setUpdate(current)
    } catch (caught) {
      if (generation === checkGeneration && !checkFailed()) {
        setError(errorMessage(caught, 'Version status is unavailable'))
      }
    }
  }

  onMount(() => {
    if (desktopRuntime() && !open()) void loadCurrentStatus()
  })

  const checkForUpdates = async () => {
    if (!desktopRuntime()) {
      setError('Update checks are available from the desktop app.')
      return
    }
    const requestGeneration = ++checkGeneration
    setBusy(true)
    setError('')
    setCheckFailed(false)
    try {
      const checked = await props.adapter.check()
      if (requestGeneration === checkGeneration) applyCheckResult(checked)
    } catch (caught) {
      if (requestGeneration === checkGeneration) {
        failCheck(caught, 'Could not check for updates')
        await loadCurrentStatus(requestGeneration)
      }
    } finally {
      if (requestGeneration === checkGeneration) setBusy(false)
    }
  }

  createEffect(() => {
    if (!open() || !desktopRuntime()) return
    let active = true
    const requestGeneration = ++checkGeneration
    setError('')
    setCheckFailed(false)
    setBusy(true)
    void (async () => {
      try {
        const current = await props.adapter.getStatus()
        if (!active) return
        setUpdate(current)
        const checked = await props.adapter.check()
        if (active && requestGeneration === checkGeneration) applyCheckResult(checked)
      } catch (caught) {
        if (active && requestGeneration === checkGeneration) {
          failCheck(caught, 'Could not check for updates')
        }
      } finally {
        if (active && requestGeneration === checkGeneration) setBusy(false)
      }
    })()
    onCleanup(() => {
      active = false
      checkGeneration += 1
    })
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
      } else {
        setCheckFailed(false)
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
  const isCurrent = () => update()?.phase === 'current' && !error() && !checkFailed() && !busy()

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
          {phaseLabel(update(), props.fallbackVersion ?? '0.1.0', checkFailed())}
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
                    when={isCurrent()}
                    fallback={
                      <Show
                        when={update()?.phase === 'available' && update()?.available_version}
                        fallback={
                          checkFailed()
                            ? 'The latest version could not be confirmed. Retry the update check to verify its status.'
                            : update()?.phase === 'checking'
                              ? 'Checking the signed release channel…'
                              : desktopRuntime()
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
                {checkFailed() ? 'Retry update check' : 'Check latest version'}
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

          <Show when={isCurrent()}>
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
