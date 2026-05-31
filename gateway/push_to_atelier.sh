#!/bin/bash

# Load environment variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$ATELIER_API_TOKEN" ]; then
  echo "Error: ATELIER_API_TOKEN not found in .env"
  exit 1
fi

# Create custom askpass helper inside workspace
ASKPASS_PATH="$(pwd)/.git_askpass.sh"
echo '#!/bin/sh' > "$ASKPASS_PATH"
echo "echo \"$ATELIER_API_TOKEN\"" >> "$ASKPASS_PATH"
chmod +x "$ASKPASS_PATH"

export GIT_ASKPASS="$ASKPASS_PATH"
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

# Clean up askpass helper
rm "$ASKPASS_PATH"
