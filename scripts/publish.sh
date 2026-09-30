#!/bin/sh
# Publishes every package whose version isn't on npm yet.
#   scripts/publish.sh <otp>     (the one-time password of the npm account)
# One password covers the lot: it is sent with each publish while it lasts.
set -e
cd "$(dirname "$0")/.."
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
