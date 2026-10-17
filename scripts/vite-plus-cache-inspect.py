#!/usr/bin/env python3
"""Diagnostic for the Vite+ cache proof lane: print what the saved task cache records about `.vite-temp`.

Usage: vite-plus-cache-inspect.py <cache dir>. Read-only; asserts nothing.
"""
import re
import sqlite3
import sys
from pathlib import Path


def printable(blob: bytes) -> str:
    return re.sub(r'[^\x20-\x7e]', '.', blob.decode('latin-1'))


def main(root: str) -> None:
    for db in sorted(Path(root).glob('v*/cache.db')):
        print(f'{db} ({db.stat().st_size} bytes)')
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        for table in ('cache_entries', 'task_fingerprints'):
            rows = con.execute(f'select key, value from {table}').fetchall()
            hits = 0
            for key, value in rows:
                for match in re.finditer(rb'vite-temp', value):
                    hits += 1
                    start = max(0, match.start() - 90)
                    print(f'  {table} key={key.hex()[:12]} len={len(value)} @{match.start()}: {printable(value[start : match.end() + 40])}')
            print(f'  {table}: {len(rows)} rows, {hits} `vite-temp` occurrences')
        con.close()


if __name__ == '__main__':
    main(sys.argv[1])
