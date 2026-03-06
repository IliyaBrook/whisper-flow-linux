#!/usr/bin/env bash
# Common launcher functions for Wispr Flow (AppImage and deb)
# Sourced by both launchers to avoid code duplication

# Setup logging directory and file
# Sets: log_dir, log_file
setup_logging() {
	log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/wispr-flow"
	mkdir -p "$log_dir" || return 1
	log_file="$log_dir/launcher.log"
}

# Log a message to the log file
log_message() {
	echo "$1" >> "$log_file"
}

# Detect display backend (Wayland vs X11)
# Sets: is_wayland, use_x11_on_wayland
detect_display_backend() {
	is_wayland=false
	[[ -n $WAYLAND_DISPLAY ]] && is_wayland=true

	# Default: Use X11/XWayland on Wayland for compatibility
	# Set WISPR_USE_WAYLAND=1 to use native Wayland
	use_x11_on_wayland=true
	[[ $WISPR_USE_WAYLAND == '1' ]] && use_x11_on_wayland=false
}

# Build Electron arguments array based on display backend and package type
# Requires: is_wayland, use_x11_on_wayland (call detect_display_backend first)
# Sets: electron_args array
# Arguments: $1 = "appimage" or "deb"
build_electron_args() {
	local package_type="${1:-deb}"

	electron_args=()

	# AppImage always needs --no-sandbox (FUSE mount = no SUID)
	[[ $package_type == 'appimage' ]] && electron_args+=('--no-sandbox')

	# X11 session - sandbox works if postinst set up chrome-sandbox correctly
	if [[ $is_wayland != true ]]; then
		log_message 'X11 session detected'
		return
	fi

	# Wayland: deb also needs --no-sandbox
	[[ $package_type == 'deb' ]] && electron_args+=('--no-sandbox')

	if [[ $use_x11_on_wayland == true ]]; then
		log_message 'Using X11 backend via XWayland'
		electron_args+=('--ozone-platform=x11')
	else
		log_message 'Using native Wayland backend'
		electron_args+=('--enable-features=UseOzonePlatform,WaylandWindowDecorations')
		electron_args+=('--ozone-platform=wayland')
		electron_args+=('--enable-wayland-ime')
		electron_args+=('--wayland-text-input-version=3')
	fi
}

# Set common environment variables
setup_electron_env() {
	export ELECTRON_FORCE_IS_PACKAGED=true
}
