#!/usr/bin/env bash

WORKDIR=$1
npm pack
VERSION=$(cat package.json | jq '.version' -r)
echo "Using version $VERSION"
if [ -z $WORKDIR ]; then
  WORKDIR=".."
  echo "Defaulting to .. for work dir"
else
  echo "Starting With Dir $WORKDIR"
fi
npx -y worktreeman-$VERSION.tgz start --cwd $WORKDIR --host=auto
