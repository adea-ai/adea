// Typed fallback shell selection for the terminal pane (issue #396).
//
// When the user's $SHELL is missing or unusable, the pane never falls back
// silently: the host's advertised profiles (each backed by a real installed
// wrapper) are offered as an explicit, confirmed choice, and the chosen
// profile is reported back through the pane's creation seam. A profile for a
// shell kind Adea has no wrapper for stays selectable but is honestly marked
// as running without shell integration.
import type { ShellProfile } from '@adea-ai/types/dev-runtime'

export type ShellKindName = 'zsh' | 'bash' | 'fish' | 'unknown'

/** Local kind resolution matching the host wrapper registry's naming. */
export function shellKindOf(shellPath: string): ShellKindName {
  const name = shellPath.split('/').pop()?.toLowerCase() ?? ''
  if (name.startsWith('zsh')) return 'zsh'
  if (name.startsWith('bash')) return 'bash'
  if (name.startsWith('fish')) return 'fish'
  return 'unknown'
}

export type ShellChoice =
  | { status: 'preferred'; profile: ShellProfile }
  | {
      status: 'fallback'
      profile: ShellProfile
      reason: 'preferred_missing'
      preferredShell: string
    }
  | { status: 'unresolved'; reason: 'no_profiles' | 'no_preference'; preferredShell?: string }

export function selectShellProfile(input: {
  preferredShell?: string
  profiles: readonly ShellProfile[]
}): ShellChoice {
  const preferred = input.preferredShell
  if (preferred !== undefined && preferred !== '') {
    const match = input.profiles.find((profile) => profile.argv[0] === preferred)
    if (match) return { status: 'preferred', profile: match }
    const proposal = input.profiles[0]
    if (proposal) {
      return {
        status: 'fallback',
        profile: proposal,
        reason: 'preferred_missing',
        preferredShell: preferred,
      }
    }
    return { status: 'unresolved', reason: 'no_profiles', preferredShell: preferred }
  }
  const first = input.profiles[0]
  if (first) return { status: 'unresolved', reason: 'no_preference' }
  return { status: 'unresolved', reason: 'no_profiles' }
}

export type ShellSelectionState = Readonly<{
  choice: ShellChoice
  /**
   * A shell is only usable once the user confirmed it — the preferred
   * profile implicitly, a fallback or free pick explicitly. Until then the
   * chooser stays up; nothing spawns silently.
   */
  confirmed: boolean
  selectedProfileId?: string
}>

export function createShellSelection(input: {
  preferredShell?: string
  profiles: readonly ShellProfile[]
}): ShellSelectionState {
  const choice = selectShellProfile(input)
  return choice.status === 'preferred'
    ? { choice, confirmed: true, selectedProfileId: choice.profile.id }
    : { choice, confirmed: false }
}

/** An explicit user pick always confirms — even over a preferred profile. */
export function chooseShellProfile(
  state: ShellSelectionState,
  profiles: readonly ShellProfile[],
  profileId: string
): ShellSelectionState {
  if (!profiles.some((profile) => profile.id === profileId)) return state
  return { ...state, confirmed: true, selectedProfileId: profileId }
}

export type ShellSelectionPresentation = Readonly<{
  /** The chooser must render until a shell is confirmed. */
  showChooser: boolean
  heading: string
  detail: string
  /** The active selection's label, when one exists. */
  selectedLabel?: string
  /** Screen-reader announcement for the selection state. */
  announcement?: string
}>

export function shellSelectionPresentation(state: ShellSelectionState): ShellSelectionPresentation {
  const choice = state.choice
  if (choice.status === 'preferred') {
    return {
      showChooser: false,
      heading: '',
      detail: '',
      selectedLabel: choice.profile.label,
    }
  }
  if (choice.status === 'fallback') {
    return {
      showChooser: !state.confirmed,
      heading: `Shell not available: ${choice.preferredShell}`,
      detail:
        'That shell is not usable on this host. Choose one of the available shells below — ' +
        'nothing starts until you pick one.',
      selectedLabel:
        state.selectedProfileId === choice.profile.id ? choice.profile.label : undefined,
      announcement: `Your shell is not available. Choose a fallback shell.`,
    }
  }
  if (choice.reason === 'no_profiles') {
    return {
      showChooser: false,
      heading: 'No shell available',
      detail:
        'No usable shell is installed on this host, so this terminal cannot start. ' +
        'Install a shell and reopen the terminal.',
      announcement: 'No shell is available on this host',
    }
  }
  return {
    showChooser: !state.confirmed,
    heading: 'Choose a shell',
    detail: 'Pick the shell for this terminal — nothing starts until you choose one.',
    selectedLabel: undefined,
  }
}

/** Whether the chosen profile runs without Adea's shell integration. */
export function profileIntegrationNote(profile: ShellProfile): string | undefined {
  return shellKindOf(profile.argv[0] ?? '') === 'unknown'
    ? 'Runs without Adea shell integration: no command blocks, exit codes, or cwd tracking.'
    : undefined
}
