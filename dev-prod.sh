#!/usr/bin/env bash

WORKDIR=$1
if [ -z $WORKDIR ]; then
  WORKDIR=".."
  echo "Defaulting to .. for work dir"
else
  ehco "Starting With Dir $WORKDIR"
fi
npm pack
VERSION=$(cat package.json | jq '.version' -r)
echo "Using version $VERSION"
npx -y worktreeman-$VERSION.tgz start --cwd .. --host=auto
