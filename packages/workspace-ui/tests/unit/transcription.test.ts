import { describe, expect, test } from "bun:test";

import { mergeTranscription } from "../../src/transcription";

describe("dictation draft insertion", () => {
  test("keeps the existing draft and inserts editable text", () => {
    expect(mergeTranscription("Review the release", "before lunch.")).toBe(
      "Review the release before lunch."
    );
    expect(mergeTranscription("Review the release ", " before lunch. ")).toBe(
      "Review the release before lunch."
    );
  });

  test("does not alter the draft for an empty transcript", () => {
    expect(mergeTranscription("Keep this draft", "   ")).toBe("Keep this draft");
  });
});
