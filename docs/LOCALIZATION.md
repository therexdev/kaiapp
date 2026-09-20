# App interface languages

Koinos AI offers English, Español, Português (Brasil), Français and Deutsch. On the first desktop launch without a saved choice, a language dialog appears before the app is usable. It starts with the first supported system language, or English if none matches. Language names appear in their own language. Selecting one previews the interface; Continue saves it. Existing installations also receive the dialog once when upgrading to this version.

Change the choice at any time in **Settings → Language**. The main interface, embedded node interface, companion and tray use the preference. Changes apply without a restart or reloading forms. Translations are bundled and work offline, including Local-Only mode. No AI service or language download is required.

The preference is `interfaceLanguage` in the existing desktop `window.json` profile, so it survives restarts and local server port changes. The main and companion renderers read it through private, main-frame-checked IPC. Only the main app can save it. Browser-served UI uses localStorage; it has the Settings selector but no desktop first-launch dialog. The desktop profile remains authoritative over this renderer cache.

## Coverage and limits

The initial catalogs cover navigation, Settings, onboarding, common controls, chat setup, companion controls, and many node/wallet, Brain, connection and workflow screens. Untranslated advanced help, server errors, third-party diagnostics and OS-owned dialogs fall back to English. These initial translations need native-speaker review in Test, particularly specialized node and wallet terminology.

Chat history, AI answers, file contents, user names, workflow data, addresses, keys and other user-provided values are not translated by the interface layer. Switching language does not change the selected model, voice, microphone state or speech-command vocabulary. English-only voice engines remain English-only.

## Maintaining translations

Source English messages are keys in `ui/locales/{es,pt-BR,fr,de}.json`. Keep each key in all four catalogs. Numeric placeholders such as `{0}` must be preserved exactly. After editing, run `node scripts/build-locales.js`; commit the generated `ui/locales/catalogs.js` too. `node scripts/build-locales.js --check` validates key parity, placeholders and freshness and is part of the test suite. Adding a locale also requires adding its native name to `ui/i18n.js`.

Static app-owned markup is registered before controllers start. For dynamic markup, use `KaiI18n.html` as a template tag; interpolated values stay separate from source prose. Use complete elements, not a partial tag or attribute. Use `KaiI18n.setText(element, 'Source message')` for changing labels, and `KaiI18n.message` as a template tag for messages with values. Use explicit `value` attributes on options so translated labels cannot change serialized data. Never register model output, arbitrary external HTML or user text as a translation source. Use `setText(element, '')` to clear a registered status.

The observer registers only explicit source markers in newly rendered components. Switching language updates those text nodes and attributes without re-rendering forms. It does not search arbitrary user content for English words.

Tests cover first launch, preview/save/reopen, failed-save retry, regional detection, native persistence, trusted IPC, live switching, unchanged user data and option values. Packaging checks require the native preference module, runtime, selector, styles and bundled catalogs.
