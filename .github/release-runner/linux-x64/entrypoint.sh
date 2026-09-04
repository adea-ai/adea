#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"

./config.sh \
  --unattended \
  --ephemeral \
  --replace \
  --url https://github.com/adea-ai/agent-hq \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels agent-hq-release-linux-x64 \
  --work _work

unset RUNNER_TOKEN
./run.sh
