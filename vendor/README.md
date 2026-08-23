# Vendored Rust dependencies

## `glib-0.18.5`

This is a source-preserving backport of the upstream fix for RustSec
RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g. The fix changes the output pointer
passed to `g_variant_get_child` from an immutable reference to a mutable
reference in `VariantStrIter::impl_get`.

The application still requires the GTK3-era `glib` 0.18 API through Tauri's
Linux desktop dependency chain, so this backport keeps the compatible crate
version while removing the affected undefined behavior. The upstream MIT
license and copyright notice are retained in the vendored crate.
