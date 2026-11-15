#!/usr/bin/env bash
# Image entrypoint (baked into the image): fetch the websandbox repo at $WSB_REF into
# $WSB_ROOT/repo, then hand over to the repo's own deploy/start.sh -- so everything except
# this file and the Dockerfile updates with a plain container restart.
set -euo pipefail
ROOT=${WSB_ROOT:-/srv}
REPO=$ROOT/repo
REF=${WSB_REF:-main}
mkdir -p "$ROOT"
log() { echo "[bootstrap $(date -u +%H:%M:%S)] $*"; }

if [ ! -d "$REPO/.git" ]; then
  log "cloning $WSB_REPO"
  rm -rf "$REPO"; git init -q "$REPO"; git -C "$REPO" remote add origin "$WSB_REPO"
fi
git -C "$REPO" remote set-url origin "$WSB_REPO"
if git -C "$REPO" fetch -q --depth 1 --force origin "$REF"; then
  git -C "$REPO" checkout -q -f --detach FETCH_HEAD
  git -C "$REPO" clean -q -fd            # untracked files go; ignored ones (node_modules) stay
  log "code at $REF = $(git -C "$REPO" rev-parse --short HEAD)"
elif git -C "$REPO" rev-parse -q --verify HEAD >/dev/null; then
  log "WARNING: fetch of $REF failed; keeping $(git -C "$REPO" rev-parse --short HEAD)"
else
  log "ERROR: cannot fetch $REF and no previous checkout"; exit 1
fi
exec bash "$REPO/deploy/start.sh"
