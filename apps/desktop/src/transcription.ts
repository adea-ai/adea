import type { TranscriptionProvider, TranscriptionSession } from "@agent-hq/workspace-ui";
import { Channel, invoke } from "@tauri-apps/api/core";

import { desktopSettingsProvider } from "./preferences";

type NativeTranscriptionEvent =
  Readonly<{ type: "complete"; text: string }> | Readonly<{ type: "error"; code: string }>;

type NativeTranscriptionDependencies = Readonly<{
  cancel(sessionId: string): Promise<void>;
  createEventChannel(onEvent: (event: NativeTranscriptionEvent) => void): unknown;
  getLocale(): Promise<string>;
  language: string;
  requestPermission(): Promise<"denied" | "granted" | "unavailable">;
  start(locale: string, events: unknown): Promise<string>;
}>;

function nativeError(code: string) {
  if (code === "permissionDenied")
    return new DOMException("System dictation permission is denied", "NotAllowedError");
  return new DOMException("System dictation failed", "OperationError");
}

export function createNativeTranscriptionProvider(
  dependencies: NativeTranscriptionDependencies
): TranscriptionProvider {
  return Object.freeze({
    id: "macos-speech-framework",
    label: "macOS system dictation",
    requestPermission: dependencies.requestPermission,
    async start(input = {}) {
      let settled = false;
      let sessionId: string | null = null;
      let rejectCompletion: (reason?: unknown) => void = () => undefined;
      let resolveCompletion: (result: Readonly<{ text: string }>) => void = () => undefined;
      const completion = new Promise<Readonly<{ text: string }>>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const channel = dependencies.createEventChannel((event) => {
        if (settled) return;
        settled = true;
        if (event.type === "complete") resolveCompletion({ text: event.text });
        else rejectCompletion(nativeError(event.code));
      });
      const configuredLocale = await dependencies.getLocale().catch(() => "");
      sessionId = await dependencies.start(
        input.locale ?? (configuredLocale || dependencies.language),
        channel
      );
      const session: TranscriptionSession = Object.freeze({
        cancel() {
          if (settled) return;
          settled = true;
          if (sessionId) void dependencies.cancel(sessionId).catch(() => undefined);
          rejectCompletion(new DOMException("Dictation cancelled", "AbortError"));
        },
        completion,
      });
      return session;
    },
  });
}

export const systemTranscriptionProvider = createNativeTranscriptionProvider({
  cancel: (sessionId) => invoke("desktop_transcription_cancel", { sessionId }),
  createEventChannel(onEvent) {
    return new Channel<NativeTranscriptionEvent>(onEvent);
  },
  getLocale: async () => (await desktopSettingsProvider.load()).dictationLocale,
  language: navigator.language,
  requestPermission: () => invoke("desktop_transcription_permission"),
  start: (locale, events) => invoke("desktop_transcription_start", { events, locale }),
});
