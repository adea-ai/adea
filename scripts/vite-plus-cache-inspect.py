#!/usr/bin/env python3
"""Diagnostic for the Vite+ cache proof lane: what the saved task cache records about `.vite-temp`, per task.

Usage: vite-plus-cache-inspect.py <cache dir>. Read-only; asserts nothing.

`task_fingerprints.key` names the task and `task_fingerprints.value` is the `cache_entries.key` of its entry; that key
holds the spawn (command and env names) and the input config, and `cache_entries.value` holds the fingerprints of the
inferred inputs. For the web build and for any entry that records `vite-temp` this prints the task name, the bytes
around it (the folder variant), the glob-like strings of the key (the input config) and every `vite-temp` occurrence
in the inferred inputs. Environment names and values are not printed.
"""

import re
import sqlite3
import sys
from pathlib import Path

GLOB = re.compile(r"[/*]|^\.|\.(json|toml|lock)$")
ENV_NAME = re.compile(r'^[A-Z_][A-Za-z0-9_()\[\]*"%]*$')


def strings(blob: bytes, minimum: int = 3) -> list[str]:
    return [
        m.decode("latin-1") for m in re.findall(rb"[\x20-\x7e]{%d,}" % minimum, blob)
    ]


def printable(blob: bytes) -> str:
    return re.sub(r"[^\x20-\x7e]", ".", blob.decode("latin-1"))


EXCLUSIONS = (
    "node_modules",
    "node_modules/.vite-temp",
    "node_modules/.vite-temp/**",
    "apps/web",
    "apps/web/public",
)


def globs_of(key: bytes) -> list[str]:
    return [
        s
        for s in strings(key)
        if s in EXCLUSIONS or (GLOB.search(s) and not ENV_NAME.match(s))
    ]


def main(root: str) -> None:
    for db in sorted(Path(root).glob("v*/cache.db")):
        print(f"{db.name} in {db.parent.name} ({db.stat().st_size} bytes)")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        entries = dict(con.execute("select key, value from cache_entries"))
        for task_key, entry_key in con.execute(
            "select key, value from task_fingerprints"
        ):
            name = next(iter(strings(task_key)), "?")
            value = entries.get(entry_key)
            if value is None:
                print(f"  {name}: no cache entry for its fingerprint key")
                continue
            hits = [m.start() for m in re.finditer(rb"vite-temp", value)]
            if name != "orch:web:build" and not hits:
                continue
            print(f"  task {name}: task key {task_key.hex()}")
            found = globs_of(entry_key)
            print(
                f"    entry key {len(entry_key)} bytes; {len(found)} glob-like strings; exclusion candidates present: {[g for g in EXCLUSIONS if g in found]}"
            )
            print(f"    config globs (first 2500 chars): {str(found)[:2500]}")
            print(
                f"    inferred inputs {len(value)} bytes; `vite-temp` occurrences: {len(hits)}"
            )
            for at in hits:
                print(f"    @{at}: {printable(value[max(0, at - 90) : at + 70])}")
        con.close()


if __name__ == "__main__":
    main(sys.argv[1])
