import path from 'node:path'
import { gzipSync } from 'node:zlib'

// Route-aware limits are based on the production workspace build recorded in
// docs/decisions/0010-performance-budgets-and-gates.md. The aggregate cap still
// catches total payload growth; the startup and view caps stop lazy features
// from consuming startup headroom without being downloaded on initial load.
export const CLIENT_BUNDLE_BUDGETS = {
  // Re-measured with the shared catalog browser (2026-10-01): 2,277,113 raw /
  // 671,890 gzip across 88 files. The plugins dialog rewrite swaps its inline
  // skeleton for the shared card/input-group/scroll-area chunks (net +2 files
  // over the previous 86), and the file-count cap followed the same lesson the
  // chat route documented: a cap pinned exactly to the last build leaves zero
  // headroom, so every new shared chunk is a budget failure. Re-measured for
  // the shared dev sidebar (2026-10-01, #853): 91 files — the archive shelf is
  // App Library's second list-row-control importer, so rolldown splits that
  // route's list-row chunk out (3 → 4 files there) and puts the total one over
  // the old cap. The cap keeps the same +2 headroom as above.
  // Re-measured for the shared accessible file tree (2026-10-01, #872): the
  // shared Tree/TreeRow composites add ~6.4 KB raw to the total. Kept at the
  // same rounding step rather than pinning to the build.
  // Re-measured for the shared app-ui boundaries (2026-10-01, #863): the
  // module split around the shared components moved the total by ~74 bytes.
  // Kept at the same rounding step rather than pinning to the build.
  // Re-measured for the shared workspace sidebar (2026-10-01, #861) on top of
  // the runtime-resources control and the rail drag-and-drop work: Chat and
  // Virtual compose one WorkspaceSidebar (now WorkspaceNavSidebar), the
  // sidebar's shared Sheet adds raw
  // while the sidebar modules move into chunks both views import, and the
  // resources sheet rides its own lazy chunk. The aggregate lands at 2,341,306
  // raw / 705,668 gzip across 93 files once main rides along (Dev-pane top-bar
  // controls), so raw and file count ratchet while
  // gzip keeps the same 700 KiB step (~2% headroom) the ceiling has held.
  // The 2026-10 dependency update (#1004) lands the aggregate at
  // 2,382,081 raw / 725,392 gzip across 93 files (shared UI 0.105.0,
  // themes 0.9.7, xterm addon minors). Raw and file count keep their
  // headroom; gzip moves 700 -> 715 KiB (~0.9% headroom).
  // The source control app (2026-10-03, #1003) adds a lazy rail app: its own
  // 144,599-raw chunk (it reuses the shared UI chunks), five more files, and
  // the 49 pull request operations in the Dev Runtime contract. Startup and
  // every other view keep their caps. The aggregate lands at 2,584,317 raw /
  // 774,540 gzip across 103 files; raw keeps ~1% headroom, gzip moves to
  // 768 KiB (~1.5%), and file count keeps its 5-file step.
  // The appearance font adoption (2026-10-04, #1016) shares the font
  // preferences across chat, browser/resources, permissions, source control,
  // files, and terminals: the aggregate lands at 2,613,405 raw / 783,567 gzip
  // across 103 files; raw keeps ~2% headroom, gzip moves 768 -> 780 KiB
  // (~2.4%), and file count keeps its 108 cap.
  // Re-measured for the cross-view sidebar shell (2026-10-04): the shared
  // utility host, archive operations, and storage-module splits add 24 lazy
  // chunks (104 → 127 files measured against the same build of main) while
  // startup drops two files and 5.4 KiB gzip — more, smaller lazy chunks is
  // the point of the change. File count ratchets 108 → 132 (5-file step);
  // the aggregate byte totals keep their caps.
  // Aggregate gzip re-measured for the same change: 2,631,666 raw /
  // 797,562 gzip against main's 774,540 — the published sidebar composition
  // and the shared archive shelf add real bytes, and the dialog/form chunks
  // that left startup are no longer deduped into it. Gzip moves 780 → 790 KiB
  // (~1.4% headroom); raw keeps its cap (~1.4% headroom at 2,631,666).
  // The #671 execution-location copy module (the task panel's persisted
  // history projection) costs 2,670,625 raw on the same build — 625 bytes
  // over the 2,670,000 cap. Raw ratchets to the next whole KiB.
  // Project sharing (2026-10-06): the lazy Share dialog, the /invite accept
  // page, and the sharing api-client/data surface add 2,699,712 raw / 821,064
  // gzip on the same build (+28.7 KB raw / +11.1 KB gzip). Raw ratchets to
  // 2,715,000 (~0.6% headroom) and gzip to 806 KiB (~0.5%); file count holds.
  // Workspace accordion (2026-10-06, ADR 0011 PR 10), measured against the
  // same build of main: 2,699,945 raw / 821,161 gzip / 132 files before,
  // 2,734,540 / 832,476 / 136 after (+34.6 KB raw / +11.3 KB gzip). The
  // shared @adea-ai/workspace-nav tree (model, adapters, WorkspaceNav,
  // NavLeafTree) and the published Tree composite replace the Chat/Virtual
  // WorkspaceSidebar, and the lazy dialog module gains the confirmation
  // dialog. Raw moves to 2,760,000 (~0.9% headroom), gzip to 840 KiB
  // (~3.2%), and file count to the next 5-file step.
  // Shared workspace sidebar in Dev (2026-10-06, ADR 0011 PR 10b), measured
  // against the same build of its base (main): 2,754,951 raw / 837,844 gzip
  // / 136 files before, 2,786,776 / 848,378 / 140 after (+31.8 KB raw /
  // +10.5 KB gzip, +4 files). The Dev NavTree projection, its bounded
  // reads, the sidebar controller and the lazy sidebar dialog and action
  // modules replace the retired Dev sidebar shell and add-project panel.
  // Raw moves to 2,815,000 (~1.0% headroom); gzip holds (~1.4%); file count
  // moves to the next 5-file step (145).
  // Sidebar bundle trim (2026-10-06), measured against the same build of
  // main (51a0d9a37): main itself measures 2,859,277 raw / 867,923 gzip /
  // 145 files — over both byte caps, because the machine-wide resources
  // sheet (#1067) landed after the #1065 re-baseline without re-running
  // this gate, and at the file cap. This change takes it to 2,854,705 /
  // 866,964 / 146 (−4,572 / −959): the Dev entry no longer ships the
  // DEV-only fixture workspace or the barrel's unused exports, and the inline
  // workspace-create row moves into its own lazy chunk (+1 file). The byte
  // caps move up to cover what main already ships, not this change: raw to
  // 2,880,000 (~0.9% headroom), gzip to 855 KiB (~1.0%); file count moves to
  // the next 5-file step (150).
  // Workspace Skills and Cloud connections (2026-10-06, ADR 0013), measured
  // against the same build of main (de8be2b94): 2,857,909 raw / 867,629 gzip
  // / 146 files before, 2,882,872 / 874,596 / 147 after (+25.0 KB raw /
  // +7.0 KB gzip, +1 file). The new lazy settings chunk (Skills and
  // Connections › Cloud panes, their model and data hooks) is 21,819 raw /
  // 6,398 gzip; startup grows 1,077 raw for the api-client methods. Without
  // the lazy chunk the total fits the previous cap. Raw moves to 2,905,000
  // (~0.8% headroom); gzip and file count hold.
  total: { rawBytes: 2_905_000, gzipBytes: 855 * 1024, fileCount: 150 },
  startup: { rawBytes: 720 * 1024, gzipBytes: 230 * 1024 },
  views: {
    // Re-measured for the shared workspace sidebar (2026-10-01, #861): the
    // Virtual view composes the shared WorkspaceSidebar (now
    // WorkspaceNavSidebar) instead of its own
    // room markup, so the route delta carries the sidebar and sidebar-nav
    // composites plus the shared Sheet: 77,771 raw / 26,357 gzip across 11
    // files (merged with main). Ratcheted past the measured value so the gate keeps ~3%
    // headroom instead of pinning to the build. Re-measured for the
    // cross-view sidebar shell (2026-10-04): 79,803 raw / 27,561 gzip — the
    // published ContextualSidebar + PixelResizeHandle composition replaces
    // the app-local resize handle (the same corvu-core swap Chat documents).
    // Raw keeps its cap; gzip ratchets to the next whole KiB (~4% headroom;
    // the old cap left 87 bytes of headroom).
    // Re-measured for the workspace accordion (2026-10-06, ADR 0011 PR 10):
    // 123,997 raw / 41,925 gzip across 18 files against the same build of
    // main's 81,582 / 27,988 / 14. Virtual mounts the shared
    // WorkspaceNavSidebar: the workspace-nav tree, the published Tree,
    // Badge, Input and typography composites, and the workspace identity
    // mark join the route; the Share host stays a lazy edge. Raw ratchets to
    // 124 KiB (~2.4% headroom); gzip to 42 KiB (~2.5%).
    // Sidebar bundle trim (2026-10-06): 112,385 raw / 37,459 gzip across 14
    // files against the same build of main's 116,663 / 39,232 / 16. The
    // inline workspace-create row and the shared Input/form-field chunks it
    // alone pulled into this route now load when "New workspace" is hovered,
    // focused or clicked. Raw ratchets down to 111 KiB (~1.1% headroom);
    // gzip to 37 KiB (~1.1%).
    virtual: { rawBytes: 111 * 1024, gzipBytes: 37 * 1024 },
    // The chat route composes the shared conversation surface and composer
    // (2026-09-30 migration) instead of app-local markup: 221,045 raw /
    // 65,600 gzip measured — the shared modules carry the keyboard and
    // composition behaviour that used to be tree-shaken into the route.
    // Re-measured for the primitives migration (2026-10-01): 224,213 raw /
    // 64,120 gzip — the settings dialog shares this route's entry, and the
    // agent roster, artifact detail, and settings row now compose shared
    // primitives there. Ratcheted to 224 KB rather than the measured value so
    // the gate carries ~2% headroom instead of the 139 bytes this route had,
    // which made every incidental change a budget failure.
    // Re-measured for the shared workspace sidebar (2026-10-01, #861): the
    // sidebar opens in the shared Sheet below 48rem, so this route now also
    // carries the sheet module graph plus the rail drag-and-drop reorder and
    // launchpad additions: 235,489 raw / 71,808 gzip measured after merging main. Ratcheted to
    // the next rounding step rather than pinning to the build.
    // Re-measured for the cross-view sidebar shell (2026-10-04): 257,431 raw /
    // 83,946 gzip across 36 files. Three drivers, measured against the same
    // build of main (237,734 / 74,907): (1) Chat/Virtual adopt the published
    // ContextualSidebar + PixelResizeHandle composition, so the corvu
    // resizable core lands on this route for the first time (+8.3 KiB gzip,
    // offset by dropping the app-local sidebar-nav-resize-handle) — Dev has
    // carried that core since #1018; (2) the shared dialog/form chunks moved
    // out of startup into this route's delta as the navigation entry stopped
    // importing them eagerly (startup dropped 231,994 → 226,633 gzip, so the
    // Chat journey total is nearly flat); (3) the shared archive shelf footer
    // and update badges add ~2.3 KiB. Raw ratchets to the next 2 KiB step
    // (~1% headroom); gzip to the next whole KiB with the usual ~3.7%.
    // Project sharing (2026-10-06): the sidebar's Share entry, the sharing
    // query/mutation hooks and the lazy dialog's host land the route at
    // 261,885 raw — 1,789 bytes over 254 KiB. Raw ratchets to the next 2 KiB
    // step; the dialog itself stays lazy and gzip keeps its cap.
    // Workspace accordion (2026-10-06, ADR 0011 PR 10): 304,387 raw /
    // 100,339 gzip across 42 files against the same build of main's 261,791
    // / 86,447 / 39 — the same WorkspaceNavSidebar delta Virtual carries
    // (the views share the chunk, so a Chat-then-Virtual journey pays it
    // once). Raw ratchets to 300 KiB (~0.9% headroom) and gzip to 100 KiB
    // (~2%).
    // Sidebar bundle trim (2026-10-06): 296,246 raw / 97,633 gzip against the
    // same build of main's 297,244 / 97,895. Chat's own entry still imports the
    // shared Input, so only the workspace-create row itself leaves the route.
    // Raw ratchets down to 294 KiB (~1.6% headroom); gzip to 97 KiB (~1.7%).
    chat: { rawBytes: 294 * 1024, gzipBytes: 97 * 1024 },
    // The library route composes the shared ListGroup/ListRow composites
    // (2026-09-29 rebuild) instead of raw divs; that costs ~2 KB raw over the
    // hand-rolled markup and is the point of the change. Re-measured for the
    // shared-UI 0.79 → 0.89.1 bump (2026-09-30): 10,999 raw / 4,060 gzip —
    // the shared Input chunk in this route's delta grew with the published
    // editor row reflow; the page itself is unchanged. Re-measured again for
    // the shared catalog browser (2026-10-01): 11,433 raw / 4,209 gzip —
    // the shared input-group now splits into its own chunk in this route's
    // delta (the plugins dialog became a second importer). Ratcheted to the
    // next whole KiB rather than the measured value; on a route this small one
    // chunk split swings hundreds of bytes, and the old cap sat 61 bytes above
    // main's own build. Re-measured for the shared dev sidebar (2026-10-01,
    // #853): 12,408 raw / 4,875 gzip across 4 files — the archive shelf is this
    // route's second ListRowControl importer, so rolldown splits
    // list-row-control into its own chunk (net +220 raw over main's 12,188/3
    // files; gzip stays under the 5 KiB cap). Ratcheted to the next whole KiB
    // for the same reason as above. Re-measured for the launchpad grid
    // (2026-10-01): 7,860 raw / 3,333 gzip across 4 files — the tile grid
    // drops the shared list-row/badge composites for plain hooks, so the
    // caps keep their headroom untouched.
    appLibrary: { rawBytes: 13 * 1024, gzipBytes: 5 * 1024 },
    // Re-baselined 40 → 41 KiB (2026-10-04, #1018): the shared annotation
    // surface adoption lands its geometry module in the Dev View shell;
    // measured 41,346 gzip. Re-measured for the cross-view sidebar shell
    // (2026-10-04): 132,313 raw / 45,745 gzip across 22 files against the
    // same build of main (127,347 / 40,998). The shell delta now carries the
    // shared dialog/form chunks that left startup (−5.4 KiB gzip there, so
    // the Dev journey total moves 272,992 → 272,378 gzip — slightly better),
    // plus the genuinely new shared archive shelf (1.6 KiB gzip), the
    // published ContextualSidebar composition around DevSidebarNavigation
    // (now DevWorkspaceSidebar)
    // (+1.5 KiB), the shared StatusChip/Badge/ListRowControl adoptions, and
    // the shell-owned utility owner while the standalone fallback still
    // constructs it eagerly. Raw ratchets to the next whole KiB (~1.4%
    // headroom); gzip to the next whole KiB above the measurement.
    // Re-measured for the add-project authorize surface and the pane empty
    // states (2026-10-05, #1033): 135,786 raw / 47,334 gzip across 25 files
    // locally, 135,885 raw in the pinned CI build — the authorize form and
    // its sidebar opener registration, the terminal/files select-a-project
    // empty states, and the Minimize2/Play/Square/FilePlus/FolderPlus icons
    // join the shell. Raw ratchets to the next whole KiB; gzip to the next
    // whole KiB above the measurement, same as the #1018 re-baseline.
    // The #666 sidebar-scale seam (the DEV-only devSidebarScale param and
    // the fixture groups' module boundary) costs 136,225 raw on the same
    // build — 33 bytes over the 133 KiB cap. Raw ratchets to the next whole
    // KiB, same as the #1033 re-baseline.
    // The shared workspace sidebar in Dev (2026-10-06, ADR 0011 PR 10b):
    // 183,639 raw / 62,430 gzip across 29 files against the same build of its
    // base (main: 131,570 / 45,777 across 23). Dev now
    // renders the shared `@adea-ai/workspace-nav` accordion Chat already
    // loads (its 33,633-byte chunk, which absorbed the ContextualSidebar
    // composition), plus the Dev NavTree projection, its bounded
    // worktree/run/diff reads and the sidebar controller (+17,484 in the Dev
    // entry), and the shared Input/FormField and the activity sets leaf status
    // reuses. The retired Dev sidebar shell and StatusChip leave the route.
    // Raw ratchets to 182 KiB (~1.5% headroom); gzip to 62 KiB (~1.7%).
    // Sidebar bundle trim (2026-10-06): 173,768 raw / 59,026 gzip across 27
    // files against the same build of main's 183,435 / 62,366 / 29. The lazy
    // Dev loader names the exports it reads (a namespace preload had kept
    // every `@adea-ai/dev-view` barrel export, the DEV-only fixture workspace
    // among them), and the workspace-create row and its Input/form-field
    // chunks leave the route. Raw ratchets down to 173 KiB (~1.9% headroom);
    // gzip to 59 KiB (~2.4%).
    devShell: { rawBytes: 173 * 1024, gzipBytes: 59 * 1024 },
    // Re-measured for the cross-view sidebar shell (2026-10-04): 172,791 raw
    // / 58,778 gzip across 19 files under the async-closure methodology this
    // gate now uses (Dev entry roots plus the shared utility host's nested
    // lazy pane imports). The rebase adopted #1018's shared AnnotationSurface
    // and ListRowControl/StatusChip compositions inside the shared panes,
    // which is what pushed past the 168 KiB / 56 KiB drafted here. Raw
    // ratchets to the next 2 KiB step (~3% headroom); gzip to the next whole
    // KiB step (~4.5%).
    // The #677 off-thread diff render boundary (worker wrapper, protocol
    // guards, the save-conflict model, and diff navigation) rides the
    // source-control app chunk inside this partition: 179,419 raw on the
    // same build — 1,243 bytes over the 174 KiB cap. Raw ratchets to the
    // next whole KiB; gzip stays at its measured step.
    // Workspace accordion (2026-10-06, ADR 0011 PR 10): the published Tree
    // composite now also loads with Chat/Virtual, so rolldown re-splits the
    // chunk the panes share with it: 178,335 raw / 61,542 gzip against the
    // same build of main's 178,006 / 60,882 (102 bytes over 60 KiB gzip).
    // Gzip ratchets to the next whole KiB; raw keeps its cap.
    devUtilityPanes: { rawBytes: 176 * 1024, gzipBytes: 61 * 1024 },
    // xterm 6.0.0 (2026-10-01, #883) ships a larger terminal core than 5.5:
    // the route measures 197,372 gzip (raw stays well under the cap). 197 KiB
    // carries ~2.2% headroom instead of leaving the cap pinned to the build.
    // Re-measured for the 2026-10 dependency update (#1004): shared UI
    // 0.105.0, themes 0.9.7, and the xterm addon minors land the route at
    // 812,192 raw / 210,342 gzip. 800 KiB raw / 211 KiB gzip keep round caps
    // with roughly the same headroom ratio instead of pinning to the build.
    // Re-measured for the source control app (2026-10-03, #1003): this route
    // carries the whole Dev Runtime contract (definitions, whose body types
    // `validateType` parses at runtime, and every reply decoder), and the 49
    // pull request operations (20 `dev.github`, 29 `dev.gitlab` mirrors) add
    // 32,406 raw over main's 812,684, landing at 845,090 raw / 214,466 gzip.
    // 832 KiB raw keeps the same ~0.8% headroom; gzip re-measured for the
    // cross-view sidebar shell (2026-10-04): 846,161 raw / 220,890 gzip —
    // this route's closure contains the Dev shell, so it inherits the same
    // partition shift and shared-composition cost documented there (main
    // measured 839,726 / 215,424 in the same build). Raw keeps its cap;
    // gzip ratchets to the next whole KiB step (~2.5% headroom).
    // seroval 1.5.6 → 1.6.8 (the security override for GHSA-p6vx-979v-rg4c /
    // GHSA-jp82-f5mq-hwhp; solid-js still pins ~1.5.4, so the override moves
    // the whole runtime) costs this route 852,808 raw on the same build —
    // +840 bytes over the 832 KiB cap. Ratchet raw one whole KiB; gzip stays
    // at its measured step.
    // That left 184 bytes of headroom. The operations stacked behind #1043
    // (cross-workspace summary, memory, connections, project bindings) each
    // add contract entries this route carries, so raw ratchets to 840 KiB
    // (~0.9% over the 852,808 measurement, the ratio the #1003 re-baseline
    // kept) instead of re-baselining once per operation; gzip is unchanged.
    // The shared workspace sidebar in Dev (2026-10-06, ADR 0011 PR 10b)
    // carries the same Dev-shell delta into this route: 902,517 raw / 238,249
    // gzip against its base build's 854,530 / 223,215 (+47,987 / +15,034:
    // the shell's sidebar modules, partly offset by a smaller command chunk
    // split on this route). Raw ratchets to 888 KiB (~0.8% headroom); gzip
    // to 234 KiB (~0.6%).
// Main then measured 911,248 raw / 240,075 gzip (51a0d9a37) — over both
    // caps after the resources sheet (#1067). The sidebar bundle trim
    // (2026-10-06) brings the route to 904,867 / 238,237 with the Dev-shell
    // savings above (the terminal pane keeps its own Input import). Both caps
    // hold.
    devTerminal: { rawBytes: 888 * 1024, gzipBytes: 234 * 1024 },
    // Same delta on the editor route (2026-10-06, ADR 0011 PR 10b): 541,499
    // raw / 171,081 gzip against its base build's 490,226 / 154,545. Raw
    // ratchets to 532 KiB (~0.6% headroom); gzip to 168 KiB (~0.6%).
    // Sidebar bundle trim (2026-10-06): 532,750 raw / 167,820 gzip against
    // the same build of main's 542,417 / 171,160 — the Dev-shell savings.
    // Raw ratchets down to 525 KiB (~0.9% headroom, the terminal route's
    // ratio); gzip to 166 KiB (~1.3%).
    devEditor: { rawBytes: 525 * 1024, gzipBytes: 166 * 1024 },
  },
}

const DEV_ENTRY_MARKERS = ['Developer workspace panes', 'No runtime projects available.']
const DEV_LAYOUT_MARKER = 'Developer center panes'
const SHARED_UTILITY_HOST_MARKER = 'Shared developer utilities'

function chunkName(file) {
  return path.posix.basename(file)
}

function uniqueChunk(chunks, predicate, label) {
  const matches = chunks.filter(predicate)
  if (matches.length !== 1) throw new Error(`Expected one ${label} chunk, found ${matches.length}`)
  return matches[0]
}

function chunkByPrefix(chunks, prefix, label) {
  return uniqueChunk(chunks, ({ file }) => chunkName(file).startsWith(prefix), label)
}

function staticImports(source) {
  const imports = new Set()
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) imports.add(match[1])
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) imports.add(match[1])
  return [...imports]
}

function dynamicImports(source) {
  const imports = new Set()
  const pattern = /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  for (const match of source.matchAll(pattern)) imports.add(match[1] ?? match[2] ?? match[3])
  return [...imports]
}

function resolveRelativeChunk(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  return resolved === '..' || resolved.startsWith('../') ? undefined : resolved
}

function dynamicChunkTargets(importers, chunksByFile) {
  const targets = new Set()
  for (const importer of importers) {
    const chunk = chunksByFile.get(importer)
    if (!chunk) throw new Error(`Missing JavaScript chunk ${importer}`)
    for (const specifier of dynamicImports(chunk.source)) {
      const target = resolveRelativeChunk(importer, specifier)
      if (!target) continue
      if (!chunksByFile.has(target)) continue
      targets.add(target)
    }
  }
  return [...targets].map((file) => chunksByFile.get(file))
}

function staticClosure(roots, chunksByFile) {
  const pending = roots.map(({ file }) => file)
  const visited = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) continue
    const chunk = chunksByFile.get(file)
    if (!chunk) throw new Error(`Missing JavaScript chunk ${file}`)
    visited.add(file)

    for (const specifier of staticImports(chunk.source)) {
      const resolved = resolveRelativeChunk(file, specifier)
      if (!resolved) continue
      if (chunksByFile.has(resolved)) {
        pending.push(resolved)
      } else if (resolved.endsWith('.js')) {
        throw new Error(`${file} statically imports missing JavaScript chunk ${resolved}`)
      }
    }
  }

  return visited
}

/** Follow a requested route and all of its nested lazy imports exactly once. */
function asyncClosure(roots, chunksByFile, preloadedFiles = new Set()) {
  const pending = roots.map(({ file }) => file)
  const visited = new Set()
  const expanded = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) continue
    const staticFiles = staticClosure([{ file }], chunksByFile)
    for (const staticFile of staticFiles) visited.add(staticFile)
    for (const staticFile of staticFiles) {
      if (preloadedFiles.has(staticFile) || expanded.has(staticFile)) continue
      expanded.add(staticFile)
      for (const target of dynamicChunkTargets([staticFile], chunksByFile)) {
        if (!visited.has(target.file)) pending.push(target.file)
      }
    }
  }

  return visited
}

function assertDynamicRouteClosure(
  roots,
  expectedTargetsByFile,
  ignoredFiles,
  chunksByFile,
  label
) {
  for (const file of staticClosure(roots, chunksByFile)) {
    if (ignoredFiles.has(file)) continue
    const chunk = chunksByFile.get(file)
    const actualTargets = new Set(
      dynamicImports(chunk.source)
        .map((specifier) => resolveRelativeChunk(chunk.file, specifier))
        .filter((target) => target && chunksByFile.has(target))
    )
    const expectedTargets = new Set(expectedTargetsByFile.get(file) ?? [])
    if (
      actualTargets.size !== expectedTargets.size ||
      [...actualTargets].some((target) => !expectedTargets.has(target))
    ) {
      throw new Error(
        `${label} dynamic chunk attribution changed in ${file}: expected ${[...expectedTargets].toSorted().join(', ')}, found ${[...actualTargets].toSorted().join(', ')}`
      )
    }
  }
}

function measure(files, chunksByFile) {
  let rawBytes = 0
  let gzipBytes = 0
  for (const file of files) {
    const chunk = chunksByFile.get(file)
    rawBytes += chunk.bytes
    gzipBytes += chunk.gzipBytes
  }
  return {
    rawBytes,
    gzipBytes,
    fileCount: files.size,
    files: [...files].toSorted(),
  }
}

function routeDelta(label, roots, startupFiles, chunksByFile, additionallyExcluded = new Set()) {
  for (const root of roots) {
    if (startupFiles.has(root.file)) {
      throw new Error(`${root.file} statically loads the ${label} entry`)
    }
  }
  const routeFiles = staticClosure(roots, chunksByFile)
  return measure(
    new Set(
      [...routeFiles].filter((file) => !startupFiles.has(file) && !additionallyExcluded.has(file))
    ),
    chunksByFile
  )
}

function asyncRouteDelta(
  label,
  roots,
  startupFiles,
  chunksByFile,
  additionallyExcluded = new Set()
) {
  for (const root of roots) {
    if (startupFiles.has(root.file)) {
      throw new Error(`${root.file} statically loads the ${label} entry`)
    }
  }
  const preloadedFiles = new Set([...startupFiles, ...additionallyExcluded])
  const routeFiles = asyncClosure(roots, chunksByFile, preloadedFiles)
  return measure(new Set([...routeFiles].filter((file) => !preloadedFiles.has(file))), chunksByFile)
}

/**
 * Measure startup plus incremental view and pane graphs. Dynamic imports
 * remain lazy and count only when their route or pane opens; shared startup
 * chunks are charged once to startup.
 */
export function inspectClientBundle(input) {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('Missing built client JavaScript chunks')

  const chunks = input.map((chunk) => {
    if (
      !chunk ||
      typeof chunk.file !== 'string' ||
      typeof chunk.source !== 'string' ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes < 0
    ) {
      throw new Error('Invalid client JavaScript chunk metadata')
    }
    const gzipBytes = chunk.gzipBytes ?? gzipSync(chunk.source).byteLength
    if (!Number.isSafeInteger(gzipBytes) || gzipBytes < 0)
      throw new Error(`Invalid gzip size for client chunk ${chunk.file}`)
    return { ...chunk, gzipBytes }
  })
  const chunksByFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  if (chunksByFile.size !== chunks.length) throw new Error('Duplicate client JavaScript chunk path')

  const startupRoots = [
    chunkByPrefix(chunks, 'client-', 'client bootstrap'),
    chunkByPrefix(chunks, 'workspace-mount-', 'workspace mount'),
    chunkByPrefix(chunks, 'workspace-navigation-entry-', 'workspace navigation entry'),
  ]
  const startupFiles = staticClosure(startupRoots, chunksByFile)

  const virtualRoot = chunkByPrefix(chunks, 'workspace-shell-', 'Virtual view')
  const chatRoot = chunkByPrefix(chunks, 'conventional-workspace-entry-', 'Chat view')
  const libraryRoot = chunkByPrefix(chunks, 'app-library-page-', 'App Library route')
  const devEntry = uniqueChunk(
    chunks,
    ({ source }) => DEV_ENTRY_MARKERS.every((marker) => source.includes(marker)),
    'Dev View entry'
  )
  if (startupFiles.has(devEntry.file)) {
    throw new Error('Workspace startup statically loads the Dev View entry')
  }
  const devLayout = uniqueChunk(
    chunks,
    ({ source }) => source.includes(DEV_LAYOUT_MARKER),
    'Dev View layout renderer'
  )
  const terminalPane = chunkByPrefix(chunks, 'terminal-pane-', 'Dev terminal pane')
  const runtimeTerminalPane = chunkByPrefix(
    chunks,
    'runtime-terminal-pane-',
    'runtime terminal pane'
  )
  const codeEditor = chunkByPrefix(chunks, 'code-editor-', 'Dev code editor')
  const editorMirror = chunkByPrefix(chunks, 'editor-mirror-', 'Dev editor renderer')
  const fileStream = chunkByPrefix(chunks, 'file-stream-', 'Dev editor file stream')
  const repoRegistryPanel = chunkByPrefix(
    chunks,
    'repo-registry-panel-',
    'Dev repository registry panel'
  )
  // The Dev sidebar's on-demand dialogs and mutations (ADR 0011) load from
  // the Dev entry like the repository registry panel they open: sidebar
  // actions, not utility panes. Matched by name; a build may inline either.
  const devSidebarOnDemand = chunks.filter(({ file }) =>
    ['dev-nav-dialogs-', 'dev-nav-actions-'].some((prefix) => chunkName(file).startsWith(prefix))
  )
  const sharedUtilityHost = uniqueChunk(
    chunks,
    ({ source }) => source.includes(SHARED_UTILITY_HOST_MARKER),
    'shared utility host'
  )
  if (startupFiles.has(sharedUtilityHost.file)) {
    throw new Error('Shared utility host is statically loaded by workspace startup')
  }
  const startupDynamicTargets = dynamicChunkTargets(startupFiles, chunksByFile)
  const sharedUtilityOpenRoots = startupDynamicTargets.filter((root) => {
    const closure = staticClosure([root], chunksByFile)
    // Dev imports the same host for its standalone fallback. Opening a
    // contextual utility must not charge the separate Dev route or its panes.
    return closure.has(sharedUtilityHost.file) && !closure.has(devEntry.file)
  })
  if (sharedUtilityOpenRoots.length !== 1) {
    throw new Error(
      `Expected one on-demand shared utility host route, found ${sharedUtilityOpenRoots.length}`
    )
  }
  // Dev's own lazy panes are direct Dev-entry imports. The shared host's lazy
  // pane roots are discovered only through its static module closure; scanning
  // every Dev descendant would misattribute dialogs such as project import.
  const devUtilityPaneRoots = [
    ...dynamicChunkTargets([devEntry.file], chunksByFile).filter(
      ({ file }) =>
        ![
          devLayout.file,
          runtimeTerminalPane.file,
          codeEditor.file,
          repoRegistryPanel.file,
          ...devSidebarOnDemand.map((chunk) => chunk.file),
        ].includes(file)
    ),
    ...dynamicChunkTargets(
      [...staticClosure([sharedUtilityHost], chunksByFile)].filter(
        (file) => !startupFiles.has(file)
      ),
      chunksByFile
    ),
  ]
  const uniqueDevUtilityPaneRoots = [
    ...new Map(devUtilityPaneRoots.map((root) => [root.file, root])).values(),
  ]
  if (uniqueDevUtilityPaneRoots.length === 0) {
    throw new Error('Dev View has no dynamically attributed utility panes')
  }
  assertDynamicRouteClosure(
    [runtimeTerminalPane, terminalPane],
    new Map([[runtimeTerminalPane.file, [terminalPane.file]]]),
    new Set([...startupFiles, devEntry.file]),
    chunksByFile,
    'Dev terminal route'
  )
  assertDynamicRouteClosure(
    [codeEditor, editorMirror, fileStream],
    new Map([[codeEditor.file, [editorMirror.file, fileStream.file]]]),
    new Set([...startupFiles, devEntry.file]),
    chunksByFile,
    'Dev editor route'
  )

  const views = {
    virtual: routeDelta('Virtual view', [virtualRoot], startupFiles, chunksByFile),
    chat: routeDelta('Chat view', [chatRoot], startupFiles, chunksByFile),
    appLibrary: routeDelta('App Library route', [libraryRoot], startupFiles, chunksByFile),
    devShell: routeDelta('Dev View', [devEntry, devLayout], startupFiles, chunksByFile),
    devUtilityPanes: asyncRouteDelta(
      'Dev utility panes',
      uniqueDevUtilityPaneRoots,
      startupFiles,
      chunksByFile,
      new Set([
        ...staticClosure([devEntry, devLayout, terminalPane, runtimeTerminalPane], chunksByFile),
        ...staticClosure([devEntry, devLayout, codeEditor, editorMirror, fileStream], chunksByFile),
      ])
    ),
    // Chat and Virtual open this host from the workspace shell. Count the
    // shell's actual dynamic edge, its static host code, and all nested lazy
    // pane chunks once, excluding dependencies already downloaded at startup.
    sharedUtilityOpen: asyncRouteDelta(
      'shared utility host',
      sharedUtilityOpenRoots,
      startupFiles,
      chunksByFile
    ),
    devTerminal: routeDelta(
      'Dev terminal route',
      [devEntry, devLayout, terminalPane, runtimeTerminalPane],
      startupFiles,
      chunksByFile
    ),
    devEditor: routeDelta(
      'Dev code editor route',
      [devEntry, devLayout, codeEditor, editorMirror, fileStream],
      startupFiles,
      chunksByFile
    ),
  }

  const total = measure(new Set(chunks.map(({ file }) => file)), chunksByFile)
  return {
    startup: measure(startupFiles, chunksByFile),
    views,
    total: { rawBytes: total.rawBytes, gzipBytes: total.gzipBytes, fileCount: total.fileCount },
  }
}

function assertByteBudget(label, measurement, budget) {
  if (measurement.rawBytes > budget.rawBytes) {
    throw new Error(
      `${label} exceeds raw byte budget: ${measurement.rawBytes} > ${budget.rawBytes} bytes`
    )
  }
  if (measurement.gzipBytes > budget.gzipBytes) {
    throw new Error(
      `${label} exceeds gzip byte budget: ${measurement.gzipBytes} > ${budget.gzipBytes} bytes`
    )
  }
}

export function assertClientBundleBudgets(report) {
  assertByteBudget('Workspace startup', report.startup, CLIENT_BUNDLE_BUDGETS.startup)
  assertByteBudget('Virtual route', report.views.virtual, CLIENT_BUNDLE_BUDGETS.views.virtual)
  assertByteBudget('Chat route', report.views.chat, CLIENT_BUNDLE_BUDGETS.views.chat)
  assertByteBudget(
    'App Library route',
    report.views.appLibrary,
    CLIENT_BUNDLE_BUDGETS.views.appLibrary
  )
  assertByteBudget('Dev View shell', report.views.devShell, CLIENT_BUNDLE_BUDGETS.views.devShell)
  assertByteBudget(
    'Dev utility panes',
    report.views.devUtilityPanes,
    CLIENT_BUNDLE_BUDGETS.views.devUtilityPanes
  )
  assertByteBudget(
    'Shared utility open',
    report.views.sharedUtilityOpen,
    CLIENT_BUNDLE_BUDGETS.views.devUtilityPanes
  )
  assertByteBudget(
    'Dev terminal route',
    report.views.devTerminal,
    CLIENT_BUNDLE_BUDGETS.views.devTerminal
  )
  assertByteBudget(
    'Dev code editor route',
    report.views.devEditor,
    CLIENT_BUNDLE_BUDGETS.views.devEditor
  )
  if (report.total.rawBytes > CLIENT_BUNDLE_BUDGETS.total.rawBytes) {
    throw new Error(
      `Total client JavaScript exceeds raw byte budget: ${report.total.rawBytes} > ${CLIENT_BUNDLE_BUDGETS.total.rawBytes} bytes`
    )
  }
  if (report.total.gzipBytes > CLIENT_BUNDLE_BUDGETS.total.gzipBytes) {
    throw new Error(
      `Total client JavaScript exceeds gzip byte budget: ${report.total.gzipBytes} > ${CLIENT_BUNDLE_BUDGETS.total.gzipBytes} bytes`
    )
  }
  if (report.total.fileCount > CLIENT_BUNDLE_BUDGETS.total.fileCount) {
    throw new Error(
      `Client JavaScript chunk-count budget exceeded: ${report.total.fileCount} > ${CLIENT_BUNDLE_BUDGETS.total.fileCount} files`
    )
  }
}
