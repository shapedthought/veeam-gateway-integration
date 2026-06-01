#!/bin/bash

# Load environment variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$ATELIER_API_TOKEN" ]; then
  echo "Error: ATELIER_API_TOKEN not found in .env"
  exit 1
fi

# Create the git askpass helper OUTSIDE the repo (mktemp) so it can never be
# swept into a commit by `git add -A` — that is how the token leaked before.
# The helper echoes the env var by name, so the token itself is never written
# to disk; the EXIT trap removes the file even if the script fails midway.
ASKPASS_PATH="$(mktemp)"
trap 'rm -f "$ASKPASS_PATH"' EXIT
printf '#!/bin/sh\necho "$ATELIER_API_TOKEN"\n' > "$ASKPASS_PATH"
chmod +x "$ASKPASS_PATH"

export GIT_ASKPASS="$ASKPASS_PATH"
export ATELIER_API_TOKEN   # make the token visible to the askpass subprocess
export DISPLAY=dummy

# Initialize and configure git
git config user.name "AI Assistant"
git config user.email "assistant@local"

git remote remove atelier 2>/dev/null
git remote add atelier "http://x-access-token@atelier.home.arpa/api/git/veeam-gateway.git"

# Commit changes
git add -A
git commit -m "Deploy Veeam Proxy to Atelier"

# Push
echo "Pushing code to Atelier..."
git push -f atelier master:main

# askpass helper is removed automatically by the EXIT trap set above
