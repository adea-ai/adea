#!/bin/bash
set -e
cd /Users/amf/Developer/Adea/adea
# 1. fresh attempt + seed
URL=$(bun -e "
import { createDesktopAuthorizationAttempt, createDesktopAuthorizationUrl } from './packages/auth/src/desktop.ts'
import { writeFileSync, mkdirSync } from 'node:fs'
const attempt = await createDesktopAuthorizationAttempt()
const url = createDesktopAuthorizationUrl('https://adea.dev', attempt)
const stateDir = process.env.HOME + '/Library/Application Support/shell-bench-electron/bench-state'
mkdirSync(stateDir, { recursive: true })
writeFileSync(stateDir + '/auth-attempt.json', JSON.stringify(attempt))
console.log(url)
" | tail -1)
echo "authorized url ready"
# 2. authorize with session cookie -> capture callback from fragment redirect
REDIRECT=$(curl -s -b /tmp/adea-jar.txt -o /dev/null -w "%{redirect_url}" "$URL" --max-time 20)
CALLBACK=$(python3 -c "
import urllib.parse, sys
u = sys.argv[1]
frag = u.split('#', 1)[1]
kv = dict(p.split('=', 1) for p in frag.split('&'))
print(urllib.parse.unquote(kv['callback'], errors='strict'))
" "$REDIRECT")
echo "callback captured"
# 3. seed callback and launch bench immediately
STATE="$HOME/Library/Application Support/shell-bench-electron/bench-state"
printf '%s' "$CALLBACK" > "$STATE/callback.txt"
cd apps/shell-bench
bun runner/run-bench.mjs --only=electron
