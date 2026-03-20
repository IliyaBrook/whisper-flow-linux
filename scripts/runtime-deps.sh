#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-check}"

if [[ "$MODE" != "check" && "$MODE" != "install" ]]; then
  echo "Usage: $0 <check|install>" >&2
  exit 1
fi

APT_RUNTIME_PACKAGES=(
  libgtk-3-0
  libnotify4
  libnss3
  libxss1
  libxtst6
  xdg-utils
  libatspi2.0-0
  libsecret-1-0
  xdotool
  xclip
)

APT_WAYLAND_PACKAGES=(
  wl-clipboard
  ydotool
)

DNF_RUNTIME_PACKAGES=(
  gtk3
  libnotify
  nss
  libXScrnSaver
  libXtst
  xdg-utils
  at-spi2-core
  libsecret
  xdotool
  xclip
)

DNF_WAYLAND_PACKAGES=(
  wl-clipboard
  ydotool
)

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

use_native_wayland() {
  [[ "${WISPR_USE_WAYLAND:-0}" == "1" ]]
}

is_package_installed() {
  local package_manager="$1"
  local package_name="$2"

  case "$package_manager" in
    apt)
      dpkg -s "$package_name" >/dev/null 2>&1
      ;;
    dnf)
      rpm -q "$package_name" >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

find_missing_packages() {
  local package_manager="$1"
  shift
  local package_name

  for package_name in "$@"; do
    if ! is_package_installed "$package_manager" "$package_name"; then
      printf '%s\n' "$package_name"
    fi
  done
}

print_missing_dependency_help() {
  local package_manager="$1"
  shift
  local missing_packages=("$@")

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    return
  fi

  echo "Missing required runtime dependencies for Wispr Flow:"
  printf '  %s\n' "${missing_packages[@]}"
  echo

  case "$package_manager" in
    apt)
      echo "Install them with:"
      echo "  sudo apt install ${missing_packages[*]}"
      ;;
    dnf)
      echo "Install them with:"
      echo "  sudo dnf install ${missing_packages[*]}"
      ;;
  esac
}

install_optional_apt_packages() {
  local available=()
  local package_name

  for package_name in "$@"; do
    if apt-cache show "$package_name" >/dev/null 2>&1; then
      available+=("$package_name")
    else
      echo "Skipping optional package '$package_name': not available in configured APT repositories."
    fi
  done

  if [[ ${#available[@]} -gt 0 ]]; then
    sudo apt-get install -y "${available[@]}"
  fi
}

package_manager="$(detect_package_manager)"

case "$package_manager" in
  apt)
    runtime_packages=("${APT_RUNTIME_PACKAGES[@]}")
    wayland_packages=("${APT_WAYLAND_PACKAGES[@]}")
    ;;
  dnf)
    runtime_packages=("${DNF_RUNTIME_PACKAGES[@]}")
    wayland_packages=("${DNF_WAYLAND_PACKAGES[@]}")
    ;;
  *)
    echo "Unsupported Linux distribution. Cannot determine runtime dependencies automatically." >&2
    exit 1
    ;;
esac

if [[ "$MODE" == "check" ]]; then
  missing_packages=()
  while IFS= read -r package_name; do
    [[ -n "$package_name" ]] && missing_packages+=("$package_name")
  done < <(find_missing_packages "$package_manager" "${runtime_packages[@]}")

  if use_native_wayland; then
    while IFS= read -r package_name; do
      [[ -n "$package_name" ]] && missing_packages+=("$package_name")
    done < <(find_missing_packages "$package_manager" "${wayland_packages[@]}")
  fi

  if [[ ${#missing_packages[@]} -gt 0 ]]; then
    print_missing_dependency_help "$package_manager" "${missing_packages[@]}"
    exit 1
  fi

  echo "Runtime dependencies for Wispr Flow are installed."
  exit 0
fi

case "$package_manager" in
  apt)
    echo "Debian/Ubuntu system detected."
    echo "Installing required runtime dependencies for Wispr Flow..."
    sudo apt-get update
    sudo apt-get install -y "${runtime_packages[@]}"

    if use_native_wayland; then
      echo "Native Wayland mode requested. Installing Wayland helper tools when available..."
      install_optional_apt_packages "${wayland_packages[@]}"
    else
      echo "Default X11/XWayland mode enabled. Native Wayland helper tools are optional."
    fi
    ;;

  dnf)
    echo "Fedora/RHEL system detected."
    echo "Installing required runtime dependencies for Wispr Flow..."
    sudo dnf install -y "${runtime_packages[@]}"

    if use_native_wayland; then
      echo "Native Wayland mode requested. Installing Wayland helper tools..."
      sudo dnf install -y "${wayland_packages[@]}"
    else
      echo "Default X11/XWayland mode enabled. Native Wayland helper tools are optional."
    fi
    ;;
esac

echo "Runtime dependencies for Wispr Flow are installed."
