#!/bin/sh
# Publishes every package whose version isn't on npm yet.
#   scripts/publish.sh [otp]     (by hand: the npm account's one-time password)
# GitHub Actions runs it with no password on each version bump pushed to
# main (.github/workflows/publish.yml, npm's trusted publishing).
# One password covers the lot: it is sent with each publish while it lasts.
set -e
cd "$(dirname "$0")/.."
# npm's own registry, whatever ~/.npmrc names (a mirror such as npmmirror
# takes no publish)
export npm_config_registry=https://registry.npmjs.org
bun scripts/check.mjs
otp="$1"
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  version=$(node -p "require('./${dir}package.json').version")
  if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
    echo "= $name@$version is on npm already"
    continue
  fi
  (cd "$dir" && npm publish --access public ${otp:+--otp="$otp"})
done
