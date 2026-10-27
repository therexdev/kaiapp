#!/usr/bin/env bash
# Install launch shortcuts for an existing AppImage; never launch or update it.
set -euo pipefail
umask 077

fail() { printf 'Koinos AI shortcut: %s\n' "$*" >&2; exit 1; }
if [[ ${1-} == --help ]]; then
  printf 'Usage: bash install-linux-shortcut.sh [absolute-or-relative-AppImage-path]\n'
  printf 'Default: ~/Applications/KoinosAI/Koinos-AI-Alpha.AppImage (only if it exists).\n'
  exit 0
fi
[[ $# -le 1 ]] || fail 'Pass one AppImage path, or no arguments for the existing Alpha installation.'
[[ $(uname -s) == Linux ]] || fail 'This shortcut installer is for Linux.'
[[ -z ${SUDO_USER-} ]] || fail 'Run this as your desktop user, without sudo.'
[[ -n ${HOME-} && $HOME == /* ]] || fail 'Your home directory could not be identified.'

kai_image=${1:-"$HOME/Applications/KoinosAI/Koinos-AI-Alpha.AppImage"}
[[ $kai_image == "${kai_image//[[:cntrl:]]/}" ]] || fail 'The AppImage path contains control characters.'
[[ -f $kai_image && ! -L $kai_image && -r $kai_image ]] || fail 'AppImage not found. Pass the exact path to your existing AppImage; no other installation is selected automatically.'
[[ $kai_image == *.AppImage ]] || fail 'Choose the existing .AppImage file.'
kai_image=$(realpath -- "$kai_image")
# electron-updater keeps a custom versionless filename across replacements.
# A versioned download is renamed on update, so it cannot be a stable target.
[[ ! ${kai_image##*/} =~ [0-9]+\.[0-9]+\.[0-9]+ ]] || fail 'Use a versionless AppImage filename so the shortcut survives updates. Quit the app before renaming its file, then pass the new path.'

command -v xdg-user-dir >/dev/null || fail 'xdg-user-dir is needed to locate your actual Desktop. No shortcuts were written.'
kai_desktop=$(xdg-user-dir DESKTOP) || fail 'Your Desktop directory could not be read.'
kai_data=${XDG_DATA_HOME:-"$HOME/.local/share"}
for kai_path in "$kai_image" "$kai_desktop" "$kai_data"; do
  [[ $kai_path == /* && $kai_path == "${kai_path//[[:cntrl:]]/}" ]] || fail 'A shortcut directory is not a valid absolute path.'
done
[[ -d $kai_desktop ]] || fail 'The configured Desktop directory does not exist. No shortcuts were written.'
[[ $kai_desktop != "$HOME" ]] || fail 'Desktop icons are disabled in your desktop configuration. No shortcuts were written.'

kai_dir="$kai_data/koinos-ai/launcher"
kai_launcher="$kai_dir/launch.sh"
kai_icon="$kai_dir/icon.svg"
kai_menu="$kai_data/applications/io.koinosai.appimage.desktop"
kai_desktop_file="$kai_desktop/Koinos AI.desktop"
kai_marker='X-KoinosAI-Managed=true'
# Preserve unrelated launchers or user files, including symbolic links.
for kai_file in "$kai_launcher" "$kai_icon" "$kai_menu" "$kai_desktop_file"; do
  [[ ! -L $kai_file ]] || fail 'An existing shortcut is a symbolic link; it was left unchanged.'
  if [[ -e $kai_file ]]; then
    [[ -f $kai_file ]] && grep -Fq -- "$kai_marker" "$kai_file" || fail 'An unrelated file already uses a shortcut location; it was left unchanged.'
  fi
done

mkdir -p -- "$kai_dir" "$kai_data/applications"
kai_tmp=$(mktemp -d "$kai_dir/.install.XXXXXX")
trap 'rm -rf -- "$kai_tmp"' EXIT
# Bash %q protects the executable path without interpreting it as a command.
# No shell flags, profile overrides, arguments, or sandbox changes are added.
printf '#!/bin/bash\n# %s\ncd -- %q || exit 1\nexec -- %q\n' "$kai_marker" "${kai_image%/*}" "$kai_image" > "$kai_tmp/launch.sh"
cat > "$kai_tmp/icon.svg" <<'SVG'
<!-- X-KoinosAI-Managed=true -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="blue" x2=".8" y2="1"><stop stop-color="#03cefa"/><stop offset="1" stop-color="#0856f9"/></linearGradient></defs><g fill="none" stroke="url(#blue)" stroke-width="11" stroke-linecap="round"><path d="M11 10v7M11 38V28L35 9M26 29l12 10"/></g></svg>
SVG
# Desktop Entry strings are decoded before Exec argument quoting. Escape both
# layers; %% is the literal percent escape, never a file/URL field argument.
entry_string() {
  local kai_value=$1
  kai_value=${kai_value//\\/\\\\}
  printf '%s' "$kai_value"
}
exec_argument() {
  local kai_value=$1
  kai_value=${kai_value//\\/\\\\}
  kai_value=${kai_value//\"/\\\"}
  kai_value=${kai_value//\$/\\\$}
  kai_value=${kai_value//\`/\\\`}
  kai_value=${kai_value//%/%%}
  printf '"'; entry_string "$kai_value"; printf '"'
}
{
  printf '[Desktop Entry]\nType=Application\nVersion=1.0\nName=Koinos AI\nComment=Open Koinos AI\n'
  # The fixed executable also supports user paths containing an equals sign,
  # which the Desktop Entry specification disallows in the executable itself.
  printf 'Exec=/bin/bash -- '; exec_argument "$kai_launcher"; printf '\n'
  printf 'Icon='; entry_string "$kai_icon"; printf '\n'
  printf 'Terminal=false\nCategories=Utility;\nStartupNotify=true\n%s\n' "$kai_marker"
} > "$kai_tmp/app.desktop"

chmod u+x -- "$kai_image"
chmod 755 "$kai_tmp/launch.sh" "$kai_tmp/app.desktop"
chmod 644 "$kai_tmp/icon.svg"
mv -f -- "$kai_tmp/launch.sh" "$kai_launcher"
mv -f -- "$kai_tmp/icon.svg" "$kai_icon"
cp -- "$kai_tmp/app.desktop" "$kai_tmp/menu.desktop"
chmod 644 "$kai_tmp/menu.desktop"
mv -f -- "$kai_tmp/menu.desktop" "$kai_menu"
# Keep the desktop copy atomic even when Desktop is on another filesystem.
kai_desktop_tmp=$(mktemp "$kai_desktop/.koinos-ai.XXXXXX")
trap 'rm -rf -- "$kai_tmp"; rm -f -- "${kai_desktop_tmp-}"' EXIT
cp -- "$kai_tmp/app.desktop" "$kai_desktop_tmp"
chmod 755 "$kai_desktop_tmp"
mv -f -- "$kai_desktop_tmp" "$kai_desktop_file"
if command -v gio >/dev/null; then gio set "$kai_desktop_file" metadata::trusted true >/dev/null 2>&1 || true; fi
if command -v update-desktop-database >/dev/null; then update-desktop-database "$kai_data/applications" >/dev/null 2>&1 || true; fi
printf 'Created Koinos AI in your Desktop and application menu.\n'
printf 'Launch target: %s\n' "$kai_image"
printf 'Double-click Koinos AI. If your desktop asks, choose Allow Launching.\n'
