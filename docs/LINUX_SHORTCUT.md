# Raspberry Pi / Linux desktop shortcut

For the existing Alpha installation at `~/Applications/KoinosAI/Koinos-AI-Alpha.AppImage`, run:

```bash
kai_shortcut="$(mktemp)"
curl -fLsS https://raw.githubusercontent.com/therexdev/kaiapp/test/scripts/install-linux-shortcut.sh -o "$kai_shortcut" && bash "$kai_shortcut"
rm -f -- "$kai_shortcut"
```

Then double-click **Koinos AI** on the desktop, or open it from the application menu. If the desktop asks, choose **Allow Launching**. Run the command as your normal desktop user, without `sudo`. No repository clone is needed.

The script uses that exact existing Alpha file; it never downloads an app or searches for a different installation. For another installation, replace `bash "$kai_shortcut"` in the command above with `bash "$kai_shortcut" "/actual/path/Koinos-AI.AppImage"`.

Keep a versionless AppImage filename: the updater replaces that same path, so the shortcut continues to work. A versioned download filename or symbolic link is refused; quit the app before renaming its file. If you later move the AppImage, rerun the installer with its new location.

The installer uses the desktop directory reported by `xdg-user-dir DESKTOP` and the application menu under `${XDG_DATA_HOME:-$HOME/.local/share}`. It stores a small launcher and branded icon in that data directory. It preserves unrelated files, and rerunning it updates its own shortcuts. It does not launch the app, enable login startup, change the wallet/profile, or add sandbox flags. The app’s existing single-instance lock still applies.

From an existing source checkout, the same installer is available as `bash scripts/install-linux-shortcut.sh`; it still launches the specified AppImage, not the source checkout. Source-only installations continue to use `npm start`.
