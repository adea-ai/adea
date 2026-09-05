import { useCallback, useRef, useState } from "react";
import {
  characterIconUrls,
  characterIds,
  characterLabels,
  characterPartCatalog,
  configurableCharacterId,
  customCharacterIds,
  getCharacterConfiguration,
  getCustomCharacterLabel,
  isCharacterId,
  isCustomCharacterId,
  serializeCharacterConfiguration,
  type CharacterConfiguration,
} from "@agent-hq/characters";
import { CharacterDesignerScene } from "@agent-hq/character-designer-scene";

const characterOptions = [
  ...characterIds.map((id) => ({
    id,
    label: characterLabels[id],
    iconUrl: characterIconUrls[id],
  })),
  ...customCharacterIds.map((id) => ({
    id,
    label: getCustomCharacterLabel(id) ?? id,
    iconUrl: undefined,
  })),
];

function initialCharacterFromUrl(): string {
  const value = new URLSearchParams(window.location.search).get("character");
  return value && (isCharacterId(value) || isCustomCharacterId(value))
    ? value
    : configurableCharacterId;
}

function leaveDesigner() {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("characterDesigner", "0");
  nextUrl.searchParams.set("view", "virtual");
  window.location.assign(nextUrl);
}

export function DesktopCharacterDesigner() {
  const [character, setCharacter] = useState(initialCharacterFromUrl);
  const [characterConfiguration, setCharacterConfiguration] = useState<
    CharacterConfiguration | undefined
  >(() => getCharacterConfiguration(character));
  const [hasEdits, setHasEdits] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);

  const updateUrl = useCallback((value: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("character", value);
    window.history.replaceState(null, "", nextUrl);
  }, []);
  const handleCharacterChange = useCallback(
    (nextCharacter: string) => {
      if (!isCharacterId(nextCharacter) && !isCustomCharacterId(nextCharacter)) return;
      setCharacter(nextCharacter);
      setCharacterConfiguration(getCharacterConfiguration(nextCharacter));
      updateUrl(nextCharacter);
    },
    [updateUrl]
  );
  const handleConfigurationChange = useCallback(
    (nextConfiguration: CharacterConfiguration) => {
      setCharacter(configurableCharacterId);
      setCharacterConfiguration(nextConfiguration);
      updateUrl(serializeCharacterConfiguration(nextConfiguration));
    },
    [updateUrl]
  );
  const handleConfigurationReset = useCallback(() => {
    setCharacterConfiguration(undefined);
    updateUrl(character);
  }, [character, updateUrl]);
  const handleClose = useCallback(
    (options?: { skipPrompt?: boolean }) => {
      if (hasEdits && !options?.skipPrompt) {
        setPendingClose(true);
        return;
      }
      leaveDesigner();
    },
    [hasEdits]
  );
  const handleSave = useCallback(
    ({
      character: savedCharacter,
      configuration,
    }: {
      character: string;
      configuration?: CharacterConfiguration;
    }) => {
      updateUrl(
        savedCharacter === configurableCharacterId && configuration
          ? serializeCharacterConfiguration(configuration)
          : savedCharacter
      );
    },
    [updateUrl]
  );

  return (
    <>
      <CharacterDesignerScene
        character={character}
        characterOptions={characterOptions}
        characterConfiguration={characterConfiguration}
        characterPartOptions={characterPartCatalog}
        onCharacterChange={handleCharacterChange}
        onCharacterConfigurationChange={handleConfigurationChange}
        onCharacterConfigurationReset={handleConfigurationReset}
        onSave={handleSave}
        onClose={handleClose}
        saveRef={saveRef}
        onDirtyChange={setHasEdits}
      />
      {pendingClose ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-designer-desktop-save-title"
            className="w-full max-w-sm rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl"
          >
            <h2 id="character-designer-desktop-save-title" className="text-base font-semibold">
              Save character changes?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You have unsaved character edits. Save them before leaving?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-2 text-sm"
                onClick={() => setPendingClose(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="rounded-md bg-destructive px-3 py-2 text-sm text-destructive-foreground"
                onClick={leaveDesigner}
              >
                Discard
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                onClick={async () => {
                  const saved = await saveRef.current?.();
                  if (saved !== false) leaveDesigner();
                }}
              >
                Save &amp; continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
