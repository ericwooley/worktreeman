#!/usr/bin/env bash

set -euo pipefail

REPO_SLUG="ericwooley/worktreeman"
BINARY_NAME="worktreeman"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${WORKTREEMAN_VERSION:-latest}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Error: required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux) os="linux" ;;
    Darwin) os="macos" ;;
    *)
      printf 'Error: unsupported operating system: %s\n' "$os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      printf 'Error: unsupported architecture: %s\n' "$arch" >&2
      exit 1
      ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

resolve_version() {
  local api_url version_file

  if [ "$VERSION" != "latest" ]; then
    printf '%s\n' "$VERSION"
    return
  fi

  api_url="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
  version_file="$(mktemp)"
  trap 'rm -f "$version_file"' RETURN
  download "$api_url" "$version_file"
  python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])' < "$version_file"
}

download() {
  local url output
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
    return
  fi

  printf 'Error: curl or wget is required to download release assets\n' >&2
  exit 1
}

verify_checksum() {
  local checksum_file asset_name asset_path expected actual
  checksum_file="$1"
  asset_name="$2"
  asset_path="$3"

  expected="$(awk -v asset="$asset_name" '$2 ~ ("/" asset "$") || $2 == asset { print $1; exit }' "$checksum_file")"
  if [ -z "$expected" ]; then
    printf 'Error: checksum entry not found for %s\n' "$asset_name" >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$asset_path" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
  fi

  if [ "$expected" != "$actual" ]; then
    printf 'Error: checksum mismatch for %s\n' "$asset_name" >&2
    exit 1
  fi
}

main() {
  local platform version asset_name release_base tmp_dir binary_tmp checksum_tmp destination

  need_cmd uname
  need_cmd mktemp
  need_cmd chmod
  need_cmd mkdir
  need_cmd grep
  need_cmd awk
  need_cmd install
  need_cmd python3
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    printf 'Error: sha256sum or shasum is required to verify downloads\n' >&2
    exit 1
  fi

  platform="$(detect_platform)"
  version="$(resolve_version)"
  asset_name="${BINARY_NAME}-${platform}"
  release_base="https://github.com/${REPO_SLUG}/releases/download/${version}"

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  binary_tmp="${tmp_dir}/${asset_name}"
  checksum_tmp="${tmp_dir}/worktreeman-checksums.txt"

  printf 'Installing %s %s for %s\n' "$BINARY_NAME" "$version" "$platform"

  download "${release_base}/${asset_name}" "$binary_tmp"
  download "${release_base}/worktreeman-checksums.txt" "$checksum_tmp"
  verify_checksum "$checksum_tmp" "$asset_name" "$binary_tmp"

  mkdir -p "$INSTALL_DIR"
  destination="${INSTALL_DIR}/${BINARY_NAME}"
  install -m 755 "$binary_tmp" "$destination"

  printf 'Installed to %s\n' "$destination"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) printf 'Note: %s is not on your PATH\n' "$INSTALL_DIR" ;;
  esac
}

main "$@"
