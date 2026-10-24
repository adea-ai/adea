# Installed-artifact qualification — private Sim payload exclusion (G, read-only)

A read-only qualification of the **exact existing packaged desktop artifacts**
on this machine, against W6's Sim payload classifier repair
([#1520](https://github.com/adea-ai/adea/pull/1520), head
`7b0e457da8972b2db644727cdd7213255961f712`).

Nothing was installed, launched, signed, re-signed or edited. W6's scripts and
assets were read and executed **from copies in a scratch directory**; no W6
file was modified, and no W6 branch was checked out.

## 1. The artifacts under inspection

| Artifact                              | Identity                                                                                     | Built            | Origin                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `stable-macos-arm64-Adea.app.tar.zst` | sha256 `6756f0c04fb348e560c359c6ebe1afdf64ebeb08989169f690f12d1007f05a63`, 123,864,331 bytes | 2026-10-19 19:45 | `adea-stable-fresh-install-qual` scope's artifacts directory |
| `macos-arm64-Adea.dmg`                | sha256 `0eebe75602919b7d950d14d390580b94c6aa604f9b0e2873d451c6ae27945777`, 127,576,262 bytes | 2026-10-19 19:45 | same build                                                   |

Both digests match the ones the Oct-19 stable-build qualification recorded, so
these are the **same real artifacts** that qualification produced, not a
reconstruction.

The archive's inner application:

| Fact                 | Value                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Bundle               | `Adea.app`                                                                                                   |
| Identity             | version `0.98.0`, channel **stable**, name `Adea`, identifier `dev.adea.desktop`, build hash `3mh2iucsb6iyg` |
| Runtime              | Electrobun **2.0.4**, bundled CEF, bundled Bun 1.4.0, `defaultRenderer: native`                              |
| URL scheme           | `adea` (`CFBundleURLTypes` → `CFBundleURLSchemes`)                                                           |
| Client target record | `{"mode":"release","cloudOrigin":"https://adea.dev"}`                                                        |
| Archive entries      | 827                                                                                                          |
| Inner client         | 317 files, 4,050,421 bytes                                                                                   |

This is a **release-mode** bundle (`mode: release`, hosted origin
`https://adea.dev`) — a stronger artifact than the local-target dev bundle
this lane installed earlier.

The DMG was mounted **read-only** (`hdiutil attach -nobrowse -readonly`) to
confirm it carries the same application and no model payload, and was
detached again immediately; nothing was copied out of it and nothing was
installed from it.

## 2. The real archive's contents — expected vs actual

| Expectation                                                 | Actual                                                                                                                                                              | Result |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| The installed bundle carries no Sim engine payload          | the whole extracted tree contains **0** files matching `.obj`, `.glb`, `.gltf`, `.fbx`, `.blend`, `.ktx2`, `.basis`, and no `basis_transcoder.*` and no `engine.js` | holds  |
| The installed bundle carries no `assets/agent-sim` tree     | no `assets/agent-sim` path exists anywhere in the archive listing (827 entries)                                                                                     | holds  |
| The installed bundle carries no model assets under any name | 0 model files in the DMG's `Adea.app` either                                                                                                                        | holds  |
| The desktop payload gate accepts the real archive           | `main` classifier: `{"files":827,"simPayloadFiles":0}`, exit 0                                                                                                      | holds  |
| The desktop payload gate accepts the real inner client      | `main` classifier: `{"files":317,"bytes":4050421,"simPayloadFiles":0}`, exit 0                                                                                      | holds  |

### The two designer-named chunks (an observation, not an exposure)

The real client carries two chunks whose names begin with the designer module
names the guard treats as offenders:

```
Adea.app/Contents/Resources/app/client/start-assets/character-designer-entry-BTAl5e2I.js   (496 bytes)
Adea.app/Contents/Resources/app/client/start-assets/room-designer-entry-DYUrPeBH.js          (521 bytes)
```

The guard's designer rule is anchored to an exact basename
(`(^|/)(engine|character-designer|room-designer)\.(js|css)$`), so it does not
match a build-renamed chunk, and neither classifier flags these two paths.

Their **content** was read: each is a thin hosted-launch stub that imports the
shared `hosted-sim-entry-*.js` chunk and renders a workspace shell around the
hosted surface. Neither carries engine code, a model, a texture or a decoder.
So the shipped bundle excludes the private Sim payload in substance, and the
guard's designer rule is name-anchored rather than content-anchored. This is
recorded for W6 as an observation; **no W6 file was edited**, and the
classifier's behaviour is unchanged by this qualification.

## 3. Does the new `.obj` guard close the installed-bundle exposure?

W6's change is one line: the extension rule becomes
`/\.(glb|gltf|fbx|obj|blend|ktx2|basis)$/`. The classifier's paths are
lowercased before the match, so `CHAIR.OBJ` is the same offender as
`chair.obj`. Nothing else changed — the diff against `main` is exactly that
one line, so every detection `main` has is preserved.

**On the real artifact, the guard changes nothing, because the real artifact
has no `.obj` to find.** Both classifiers produce identical results on the
real archive and on the real inner client (§2).

The exposure the guard closes is a **gate** exposure, and it is reproducible
on the real archive's own layout. On a **disposable copy** of the real archive
(the shipped archive was never modified), with one moved model
(`assets/chair.obj`) and one case variant (`models/Chair.Obj`) placed inside
the inner client:

| Classifier                          | Expected             | Actual                                                                                                                                                   | Result              |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `main` @ `bf8a8df`                  | refuse a moved model | `{"files":831,"simPayloadFiles":0}`, exit 0 — **the moved models pass the installed-archive gate**                                                       | exposure reproduced |
| W6 #1520 @ `7b0e457da`              | refuse a moved model | exit 1, `Desktop contains Sim payload: Adea.app/Contents/Resources/app/client/assets/chair.obj, Adea.app/Contents/Resources/app/client/models/Chair.Obj` | **closed**          |
| W6 #1520 @ `7b0e457da` (`--client`) | refuse a moved model | exit 1, `Desktop contains Sim payload: models/Chair.Obj, assets/chair.obj`                                                                               | closed              |

**Verdict.** The `.obj` guard closes the installed-bundle gate exposure: on
the real archive's layout, a moved model is refused by the repaired classifier
and accepted by the current one, in either case. The shipped stable archive
and DMG carry **no** `.obj` (or any other model asset), so there is no
`.obj` exposure in the shipped artifact for the guard to remove — the guard
removes the _possibility_ that one is shipped unnoticed.

This is a **classifier** result on the real artifact's layout. It is **not**
installed proof: nothing was installed, and no claim is made about an
installed application in any run.

## 4. Commands and results

| Command                                                                              | Result                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `shasum -a 256 <archive>` / `<dmg>`                                                  | `6756f0c0…f05a63` / `0eebe756…45777` — the same artifacts the Oct-19 qualification recorded |
| `zstd -dc <archive> \| tar -tf -`                                                    | 827 entries; no `assets/agent-sim`; no model files; two designer-named chunks               |
| `zstd -dc <archive> \| tar -xf -`                                                    | 377 MB extracted for content inspection                                                     |
| `find extracted -type f -iname '*.obj' -o …`                                         | 0 model files in the whole tree                                                             |
| `bun main-check.mjs --archive <archive>` (script taken from `origin/main` `bf8a8df`) | `{"files":827,"simPayloadFiles":0}`, exit 0                                                 |
| `bun main-check.mjs --client <extracted inner client>`                               | `{"files":317,"bytes":4050421,"simPayloadFiles":0}`, exit 0                                 |
| `bun w6-check.mjs --archive <archive>` (script taken from #1520 head `7b0e457da`)    | `{"files":827,"simPayloadFiles":0}`, exit 0 — identical to `main`                           |
| `bun w6-check.mjs --client <extracted inner client>`                                 | `{"files":317,"bytes":4050421,"simPayloadFiles":0}`, exit 0                                 |
| `bun main-check.mjs --archive <copy with a moved .obj>`                              | `{"files":831,"simPayloadFiles":0}`, exit 0 — the gap                                       |
| `bun w6-check.mjs --archive <copy with a moved .obj>`                                | exit 1, both offenders named — the gap closed                                               |
| `hdiutil attach -nobrowse -readonly <dmg>` / `hdiutil detach`                        | mounted read-only, `Adea.app` present, 0 model files, detached again                        |

The two classifier scripts were executed from copies in a scratch directory —
`main`'s from `origin/main` (`bf8a8df`), W6's from the PR head
(`7b0e457da`, blob `d568f581f14791e3676391befa2ff1631cb8f90c`). The diff
between them is exactly W6's one-line extension-rule change.

## 5. What is left, and the bounded next test

Nothing in this qualification is blocked: the real artifacts exist, they were
inspected, and the guard's effect on them was measured.

The one thing that cannot be produced from the artifacts on this machine is an
**installed** proof of the guard — the archive is the payload the installer
writes, and installing it is out of this lane's scope (and needs the
installation clearance this lane does not have). The bounded reproducible next
test, for a host that is cleared to install:

```sh
# 1. the real archive, unmodified — expect the gate to accept it
bun scripts/check-desktop-sim-payload.mjs --archive <real .app.tar.zst>

# 2. the same archive with one moved model, on a disposable copy — expect the
#    repaired guard to refuse it and the pre-repair classifier to accept it
#    (this is exactly what this qualification did on the real archive's layout)
```

## 6. Scope and ownership

Read-only throughout: no installation, no launch, no signing or re-signing, no
credential or security grant, no model or account change, no worker creation,
no merge, no deployment. W6's scripts and assets were read, not edited; W3's
held guide/MATRIX scope and the #1497 tasks were not touched.
