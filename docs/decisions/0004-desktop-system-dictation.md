# ADR 0004: Desktop system dictation boundary

- Status: Accepted
- Date: 2026-08-30

## Context

The M2 composer needs speech-to-text without creating a vendor-specific transcription contract or retaining microphone data. Voice chat and spatial audio are separate later features.

## Decision

Agent HQ exposes a provider-neutral `TranscriptionProvider` to the shared workspace UI. The initial desktop provider uses Apple's Speech framework (`SFSpeechRecognizer`) with an ephemeral `AVAudioEngine` microphone tap after explicit microphone and speech-recognition permission requests. The native layer removes the tap and stops the engine on completion, failure, timeout, or cancellation. It does not persist raw audio or transcripts outside the existing editable draft and does not send microphone data through Agent HQ APIs, logs, analytics, or WorkspaceEvents.

When the selected locale supports on-device recognition, the provider requires that mode. Otherwise, macOS may use Apple's speech service and may require network access. This transport behavior belongs to the operating-system provider, not the Agent HQ API.

The composer owns idle, listening, processing, cancel, unavailable, and error presentation. Cancellation and failures leave the existing draft unchanged, and successful text is inserted without sending the message. Users revoke microphone and speech-recognition access in macOS Privacy & Security settings; the next request reports the denied state.

## Consequences

- Desktop dictation depends on macOS Speech and AVFoundation availability rather than a fixed application-level vendor.
- Web and unsupported desktop environments show an accurately unavailable control.
- A future local or remote provider can implement the same boundary without changing composer state or message APIs.
- Full voice chat, streaming audio retention, and automatic message submission remain out of scope.
