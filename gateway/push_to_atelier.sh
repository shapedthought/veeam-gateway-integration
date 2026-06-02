#!/usr/bin/env bash
#
# Deploy this gateway to its Atelier app, triggering a `direct` build.
#
# The Atelier app's git repo has THIS folder's contents at its root (it is a
# single-Dockerfile app). So we do NOT push the surrounding monorepo — we clone
# the app repo, mirror this gateway/ source into it, and push a commit to `main`,
# which fires the build webhook. Nothing touches the monorepo's git history.
#
# Config (read from gateway/.env, or the environment):
#   ATELIER_API_TOKEN  (required)  Developer-role token; used for git auth.
#   ATELIER_API_URL    (optional)  REST base — only used to print the watch hint.
#   ATELIER_GIT_HOST   (optional)  git proxy host.  Default: atelier.home.arpa
#   ATELIER_APP_NAME   (optional)  app / repo name. Default: veeam-gateway
#
# Usage:
#   ./push_to_atelier.sh             deploy
#   DRY_RUN=1 ./push_to_atelier.sh   show what would deploy, push nothing
#
set -euo pipefail

# Always operate from this script's directory (the app source root).
cd "$(dirname "$0")"
SRC_DIR="$(pwd)"

# --- Config ---------------------------------------------------------------
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${ATELIER_API_TOKEN:?ATELIER_API_TOKEN not set (add it to gateway/.env)}"
ATELIER_GIT_HOST="${ATELIER_GIT_HOST:-atelier.home.arpa}"
ATELIER_APP_NAME="${ATELIER_APP_NAME:-veeam-gateway}"
REMOTE="http://x-access-token@${ATELIER_GIT_HOST}/api/git/${ATELIER_APP_NAME}.git"

# --- Temp workspace + git askpass (both OUTSIDE the repo, auto-cleaned) ----
# The askpass helper lives in a temp file so `git add -A` can never sweep it
# into a commit (that is how the token leaked once); it echoes the token by
# NAME, so the secret itself is never written to disk.
ASKPASS=""; WORKDIR=""
cleanup() { [ -n "$ASKPASS" ] && rm -f "$ASKPASS"; [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

ASKPASS="$(mktemp)"
printf '#!/bin/sh\necho "$ATELIER_API_TOKEN"\n' > "$ASKPASS"
chmod +x "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 ATELIER_API_TOKEN

# --- Clone the Atelier app repo (its root == this gateway/ folder) ---------
WORKDIR="$(mktemp -d)"
echo "Cloning ${ATELIER_APP_NAME} from Atelier…"
git clone --quiet "$REMOTE" "$WORKDIR"

# --- Mirror this source into the clone -------------------------------------
# --delete removes files that no longer exist here; the --exclude'd paths are
# protected: local cruft, build outputs Atelier writes back, and secrets.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.env' \
  --exclude 'database.sqlite' \
  --exclude '.DS_Store' \
  --exclude '.git_askpass.sh' \
  --exclude 'atelier-spec.yaml' \
  --exclude 'k8s/' \
  "$SRC_DIR"/ "$WORKDIR"/

cd "$WORKDIR"
git config user.name "${GIT_AUTHOR_NAME:-AI Assistant}"
git config user.email "${GIT_AUTHOR_EMAIL:-assistant@local}"
git add -A

if git diff --cached --quiet; then
  echo "No changes — Atelier is already up to date with this source."
  exit 0
fi

echo "Changes to deploy:"
git --no-pager diff --cached --stat

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[dry-run] Nothing pushed. Unset DRY_RUN to deploy."
  exit 0
fi

SRC_REF="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
git commit -q -m "Deploy ${ATELIER_APP_NAME} (source ${SRC_REF})"
echo "Pushing to Atelier (triggers a direct build)…"
git push origin HEAD:main

echo "Deployed. Watch the build:"
echo "  curl -N \"${ATELIER_API_URL:-http://${ATELIER_GIT_HOST}}/api/apps/${ATELIER_APP_NAME}/events\" -H \"Authorization: Bearer \$ATELIER_API_TOKEN\""
