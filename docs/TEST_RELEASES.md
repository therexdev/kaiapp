# Test first, then live

Install **Koinos AI Test** from [the test download page](https://github.com/therexdev/kaiapp/releases/tag/test-build). Windows has a separate Setup installer and portable executable. Linux has x64 and arm64 AppImages. The existing [live download](https://github.com/therexdev/kaiapp/releases/latest) stays on the stable release. This workflow currently builds Test for Windows and Linux.

| | Test | Live |
|---|---|---|
| App | Koinos AI Test | Koinos AI |
| Branch | `test` | `claude/koinos-ai-takeover-co25fw` |
| App ID | `io.koinosai.desktop.test` | `io.koinosai.desktop` |
| Desktop data | Existing Electron app-data / Koinos AI / core | Same profile |
| Headless data | `~/.koinos-ai` | Same headless profile |
| Local API | `127.0.0.1:41100` | Same port |
| Managed Ollama fallback | port 11434 | Same port |
| Updates | `test*.yml` in `test-build` | Latest stable release |

## Switching your existing node to Test

1. Choose **Quit Koinos AI** from the running app's tray menu. Closing the window can leave it running. Quit an older Test build too if one is open.
2. Install the latest **Koinos AI Test** Setup and open Test. The main app can stay installed; Test has its own shortcut and update channel.
3. Test opens your existing chats, settings, wallet, models and node configuration. It retains the configured node-data location and connects to the same live network. If the saved wallet session is available and earning was enabled, the existing startup flow resumes it. Otherwise unlock the existing wallet and check earning in the app.

Live and Test share Electron's profile lock: only one can run at a time. Test keeps the live runtime name so OS-encrypted credentials use the same identity. Trying to open Test while Live is running shows switching instructions. To switch back, quit Test through the tray, then open Live. Desktop defaults to `%APPDATA%\\Koinos AI\\core` on Windows and the corresponding Electron app-data directory on other platforms. There is no profile migration or new node database.

Before each Test version first opens the shared profile, it saves configuration and encrypted wallet/session files in `core/test-profile-backups/<version>/`. Models, chats and blockchain databases remain in place and are not duplicated. A backup failure stops Test before Core opens. These are configuration restore points, not full data backups, and they are never restored automatically over evolving live state. Development builds use the source package version for this restore point.

The first two Test builds used a separate `Koinos AI Test` profile. New builds use the existing **Koinos AI** profile; they do not merge or delete data created in those older Test builds. Test continues contributing to the existing chain and scheduler using your saved settings. Switching requires an app restart; actual earnings and node health still need checking on your computer. Other users stay on the live installer and feed.

Developer environment variables can explicitly override data and ports. Headless mode retains its original home-directory profile and has no Electron lock: do not launch a second headless process against an active profile. Test does not install a competing `koinos-code` command.

## Working here

Use `test` as the working branch. `npm start` opens the test app from source; `npm run core:test` serves its UI headlessly. `npm run start:live` retains the original source launch when deliberately needed. `npm test` runs the suite.

Every push to `test` runs tests, then packages Windows and both Linux architectures. CI stamps the next patch version with `-test.<run-number>.<attempt>`, assigns Test's installer identity and generic updater feed, and verifies those settings inside the actual packaged ASAR. Windows also tests separate Live/Test native executables: each must block the other from opening the shared profile, and Test must decrypt an OS-encrypted credential saved by Live. Windows retains the existing Azure signing configuration. Publication waits for both platforms, uploads versioned binaries first and update feeds last, and retains older binaries so ongoing downloads can finish. Checksums and a versioned build JSON record the exact source SHA and workflow run.

The `test-build` tag is a rolling download channel, not a version/source attestation. The release stays marked prerelease and is never GitHub's latest stable release. Avoid renaming it to a semver tag: old live updaters accept prereleases and derive a channel from semver tags. The non-semver tag makes them request `latest*.yml`; these compatibility manifests retain the latest live version, hashes and sibling paths to the original live assets. Test requests `test*.yml` through its fixed generic feed. New live builds also set `allowPrerelease=false`.

## Promoting ready work

The owner authorized normal pushes and ready releases. Check the exact test commit has a successful **Test installers** run, review the change, and promote it with a fresh stable version:

```bash
git switch test
npm run promote:test -- 0.54.2
```

This requires authenticated git and GitHub CLI access. The script verifies the clean/up-to-date branch, successful test build, live ancestry and version, creates a release commit, pushes it to the live desktop branch and fast-forwards Test to the same history. Equivalent GitHub connector operations can perform the same checked steps. Intervening live changes require merging into Test and a new passing build first. No force push is used.

The existing live CI builds and publishes the stable installers. It now creates the version tag at the actual release commit before electron-builder publishes (older release tags could point to the stale repository default branch). Watch CI through completion and verify release assets before reporting success. Live users receive the update on the app's existing launch / four-hour check and restart/install flow. Linux AppImages need an executable location; unsigned macOS live builds retain their existing manual-download limitation.

If a test build fails, its publish job does not run and the previous Test update feed remains available. A failed live promotion can be corrected with a newer version; do not overwrite a shipped version or reuse a release tag.
