# Test first, then live

Install **Koinos AI Test** from [the test download page](https://github.com/therexdev/kaiapp/releases/tag/test-build). Windows has a separate Setup installer and portable executable. Linux has x64 and arm64 AppImages. The existing [live download](https://github.com/therexdev/kaiapp/releases/latest) stays on the stable release. This workflow currently builds Test for Windows and Linux.

| | Test | Live |
|---|---|---|
| App | Koinos AI Test | Koinos AI |
| Branch | `test` | `claude/koinos-ai-takeover-co25fw` |
| App ID | `io.koinosai.desktop.test` | `io.koinosai.desktop` |
| Desktop data | Electron app-data / Koinos AI Test / core | Existing Electron userData / core |
| Headless data | `~/.koinos-ai-test` | `~/.koinos-ai` |
| Local API | `127.0.0.1:41101` | `127.0.0.1:41100` |
| Managed Ollama fallback | port 11435 | port 11434 |
| Updates | `test*.yml` in `test-build` | Latest stable release |

Test starts with separate chats, settings, wallet files and downloaded models. It does not copy the live profile or install a competing `koinos-code` command. Both apps can open together; running models concurrently still shares the computer's RAM/GPU. Developer environment variables can explicitly override the data and ports.

Test connects to the existing scheduler and chain services when those features are used. Remote accounts, transactions and the machine's Docker installation are not sandboxed by installing Test. Do not point Test at the live data directory. Use a fresh profile for ordinary app development.

## Working here

Use `test` as the working branch. `npm start` opens the test app from source; `npm run core:test` serves its UI headlessly. `npm run start:live` retains the original source launch when deliberately needed. `npm test` runs the suite.

Every push to `test` runs tests, then packages Windows and both Linux architectures. CI stamps the next patch version with `-test.<run-number>.<attempt>`, assigns Test's identity and generic updater feed, and verifies those settings inside the actual packaged ASAR. Windows retains the existing Azure signing configuration. Publication waits for both platforms, uploads versioned binaries first and update feeds last, and retains older binaries so ongoing downloads can finish. Checksums and a versioned build JSON record the exact source SHA and workflow run.

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
