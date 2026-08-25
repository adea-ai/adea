#!/bin/sh
set -eu

export APPIMAGE="$0"
export APPDIR="$0.extracted"
exec "$APPDIR/AppRun" "$@"
