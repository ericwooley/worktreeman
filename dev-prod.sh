#!/usr/bin/env bash

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_WORKDIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
WORKDIR=${1:-}

npm pack
VERSION=$(jq -r '.version' package.json)
echo "Using version $VERSION"

if [ -z "$WORKDIR" ]; then
  WORKDIR="$DEFAULT_WORKDIR"
  echo "Defaulting to $WORKDIR for work dir"
else
  echo "Starting With Dir $WORKDIR"
fi

npx -y worktreeman-"$VERSION".tgz start --cwd "$WORKDIR" --host=auto
