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

	# Disable Chromium custom titlebar for proper Linux window integration
	electron_args+=('--disable-features=CustomTitlebar')

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
		# Tell the helper to use X11 tools even though XDG_SESSION_TYPE=wayland
		export WISPR_DISPLAY_BACKEND=x11
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
	export ELECTRON_USE_SYSTEM_TITLE_BAR=1
}

# Register .desktop file so the system knows how to handle wispr-flow:// URLs
# Only relevant for AppImage — deb uses postinst to register.
# Arguments: $1 = appdir, $2 = appimage_path
integrate_desktop() {
	local appdir_arg="$1"
	local appimage_arg="$2"
	local desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
	local icon_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
	local desktop_file="$desktop_dir/wispr-flow-appimage.desktop"

	mkdir -p "$desktop_dir" "$icon_dir" 2>/dev/null

	# Copy icon if available
	local icon_src="$appdir_arg/wispr-flow.png"
	local icon_dest="$icon_dir/wispr-flow.png"
	if [[ -f $icon_src ]]; then
		if [[ ! -f $icon_dest ]] || ! cmp -s "$icon_src" "$icon_dest"; then
			cp "$icon_src" "$icon_dest" 2>/dev/null
		fi
	fi

	# Create/update .desktop file if AppImage path changed or file doesn't exist
	local current_exec=''
	[[ -f $desktop_file ]] && current_exec=$(grep '^Exec=' "$desktop_file" 2>/dev/null | head -1)

	if [[ ! -f $desktop_file ]] || [[ $current_exec != "Exec=\"${appimage_arg}\" %U" ]]; then
		cat > "$desktop_file" << DESKTOP
[Desktop Entry]
Name=Wispr Flow
Exec="${appimage_arg}" %U
Icon=wispr-flow
Type=Application
Terminal=false
Categories=Utility;Accessibility;
Comment=Voice-typing made perfect (AppImage)
MimeType=x-scheme-handler/wispr-flow;
StartupWMClass=Wispr Flow
DESKTOP
		log_message "Desktop file created/updated: $desktop_file"
	fi

	# Update MIME database
	update-desktop-database "$desktop_dir" 2>/dev/null || true
	xdg-mime default wispr-flow-appimage.desktop x-scheme-handler/wispr-flow 2>/dev/null || true
}
