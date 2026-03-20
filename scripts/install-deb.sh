#!/usr/bin/env bash
set -euo pipefail

DEB_FILE="${1:-}"
APPIMAGE_FILE="${2:-}"
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"

if [[ -z "$DEB_FILE" && -z "$APPIMAGE_FILE" ]]; then
  echo "Usage: $0 [/path/to/package.deb] [/path/to/Wispr_Flow.AppImage]" >&2
  exit 1
fi

if [[ -n "$DEB_FILE" && ! -f "$DEB_FILE" ]]; then
  echo "Package not found: $DEB_FILE" >&2
  exit 1
fi

if [[ -n "$APPIMAGE_FILE" && ! -f "$APPIMAGE_FILE" ]]; then
  echo "AppImage not found: $APPIMAGE_FILE" >&2
  exit 1
fi

read_os_release_field() {
  local field="$1"
  if [[ ! -f /etc/os-release ]]; then
    return 1
  fi

  awk -F= -v key="$field" '$1 == key { gsub(/^"|"$/, "", $2); print $2 }' /etc/os-release
}

detect_package_manager() {
  local distro_info
  distro_info="$(printf '%s %s' "$(read_os_release_field ID || true)" "$(read_os_release_field ID_LIKE || true)" | tr '[:upper:]' '[:lower:]')"

  if [[ "$distro_info" =~ (debian|ubuntu|linuxmint|pop|neon) ]]; then
    echo apt
    return
  fi

  if [[ "$distro_info" =~ (fedora|rhel|centos|rocky|almalinux) ]]; then
    echo dnf
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo apt
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    echo dnf
    return
  fi

  echo unknown
}

case "$(detect_package_manager)" in
  apt)
    if [[ -z "$DEB_FILE" ]]; then
      echo "Debian/Ubuntu installation requires a built .deb package."
      echo "Run: make build"
      exit 1
    fi

    bash "$(dirname "$0")/runtime-deps.sh" install
    sudo apt-get install -y dpkg
    echo "Installing package: $DEB_FILE"
    sudo dpkg -i "$DEB_FILE"
    sudo apt-get install -f -y
    ;;

  dnf)
    bash "$(dirname "$0")/runtime-deps.sh" install

    if [[ -z "$APPIMAGE_FILE" ]]; then
      APPIMAGE_FILE="$(find "$DIST_DIR" -maxdepth 1 -name 'Wispr_Flow-*-x86_64.AppImage' | head -n 1)"
    fi

    echo "Fedora/RHEL system detected."
    echo "Runtime dependencies are installed."
    echo "The supported artifact on Fedora/RHEL is the AppImage, not the .deb package."

    if [[ -n "$APPIMAGE_FILE" ]]; then
      echo "AppImage is already available:"
      echo "  $APPIMAGE_FILE"
      echo "Run it with:"
      echo "  make run"
      exit 0
    fi

    echo "Build it with:"
    echo "  make build-appimage"
    exit 1
    ;;

  *)
    echo "Unsupported Linux distribution."
    echo "Install the required runtime dependencies manually, then install:"
    echo "  $DEB_FILE"
    exit 1
    ;;
esac

echo "Wispr Flow installed successfully."
