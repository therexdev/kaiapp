'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
require('../../ui/locales/catalogs');
const i18n = require('../../ui/i18n');
const { registerLanguage } = require('../../electron/language');
const { JsonStore } = require('../lib/store');

function fixture(t, storePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-language-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = storePath || path.join(dir, 'window.json');
  const calls = [], handlers = new Map(), origin = 'http://127.0.0.1:9393';
  const window = url => ({ isDestroyed: () => false, webContents: { mainFrame: { url }, send: (...args) => calls.push(args) } });
  const main = window(origin + '/'), mascot = window(origin + '/mascot.html');
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const store = new JsonStore(file);
  const service = registerLanguage({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPreferredSystemLanguages: () => ['ja-JP', 'es-MX'], getLocale: () => 'en-US' },
    store, getMainWindow: () => main, getMascotWindow: () => mascot, origin });
  return { file, store, service, main, mascot, event, calls, read: handlers.get('shell:language'), write: handlers.get('shell:set-language') };
}

test('regional system languages resolve predictably with English fallback', () => {
  assert.equal(i18n.detect(['ja-JP', 'es-MX']), 'es');
  assert.equal(i18n.detect(['pt_PT']), 'pt-BR');
  assert.equal(i18n.detect(['de-AT']), 'de');
  assert.equal(i18n.detect(['fr-CA']), 'fr');
  assert.equal(i18n.detect(['ja-JP', 'ar']), 'en');
  assert.equal(i18n.normalize({}), null);
  assert.equal(i18n.t('Unavailable message {0}', ['<user data>'], 'fr'), 'Unavailable message <user data>');
});
test('all bundled catalogs are current and preserve every placeholder', () => {
  execFileSync(process.execPath, [path.join(__dirname, '../../scripts/build-locales.js'), '--check']);
  for (const lang of i18n.languages) assert.ok(i18n.t('Choose your language', [], lang.code));
});
test('a saved desktop preference survives restart and is shared with the companion', t => {
  const f = fixture(t);
  assert.deepEqual(f.read(f.event(f.main)), { language: 'es', selected: false });
  f.store.set('bounds', { width: 1200 });
  assert.deepEqual(f.write(f.event(f.main), 'pt-BR'), { language: 'pt-BR', selected: true });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.read(f.event(f.mascot)), { language: 'pt-BR', selected: true });
  const reopened = fixture(t, f.file);
  assert.deepEqual(reopened.service.status(), { language: 'pt-BR', selected: true });
  assert.deepEqual(reopened.store.get('bounds'), { width: 1200 });
});
test('language IPC rejects subframes, unrelated documents and unsupported writes', t => {
  const f = fixture(t), good = f.event(f.main);
  assert.throws(() => f.write(good, 'es-MX'), /Unsupported/);
  assert.throws(() => f.write(good, '__proto__'), /Unsupported/);
  assert.throws(() => f.write(f.event(f.mascot), 'de'), /denied/);
  assert.throws(() => f.read({ ...good, senderFrame: { url: good.senderFrame.url } }), /denied/);
  assert.throws(() => f.read({ ...good, sender: {} }), /denied/);
  good.senderFrame.url = 'http://127.0.0.1:9393/knode/';
  assert.throws(() => f.write(good, 'de'), /denied/);
  good.senderFrame.url = 'https://example.com/';
  assert.throws(() => f.read(good), /denied/);
  assert.equal(f.store.get('interfaceLanguage'), undefined);
});
test('failed persistence neither broadcasts a choice nor suppresses first launch', t => {
  const f = fixture(t);
  f.store.save = () => { throw new Error('disk unavailable'); };
  assert.throws(() => f.write(f.event(f.main), 'de'), /disk unavailable/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.status().selected, false);
});
