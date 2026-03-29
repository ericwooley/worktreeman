#!/usr/bin/env bash

npm pack
VERSION=$(cat package.json | jq '.version' -r)
echo "Using version $VERSION"
npx -y worktreeman-$VERSION.tgz start --cwd .. --host=auto
