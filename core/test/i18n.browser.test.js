'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || '/opt/pw-browsers/chromium';
async function fixture(t, prefs = { language: 'es', selected: false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-language-'));
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', 'smollm2-135m-instruct-q8_0.gguf'), 'weights');
  const core = await require('../server').createCore({ dataDir: dir, port: 0,
    llamaBin: path.join(__dirname, 'fixtures/fake-llama-server'), onEvent() {} });
  const origin = 'http://127.0.0.1:' + await core.start();
  const browser = await require('playwright-core').chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(async () => { await browser.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: 'es-MX' });
  await page.addInitScript(prefs => {
    window.__languageWrites = [];
    window.kaiLanguageBridge = {
      get: async () => JSON.parse(sessionStorage.getItem('fixture-language') || JSON.stringify(prefs)),
      save: async language => {
        if (window.__failLanguageSave) throw new Error('disk unavailable');
        const value = { language, selected: true }; window.__languageWrites.push(language);
        sessionStorage.setItem('fixture-language', JSON.stringify(value)); return value;
      }, onChanged: callback => { window.__languageChanged = callback; },
    };
  }, prefs);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.evaluate(() => window.kaiLanguageReady);
  return { page, origin, errors };
}
test('first launch previews native language names, persists choice, and never repeats after reopen', { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const { page, errors } = await fixture(t);
  assert.equal(await page.locator('#language-dialog').isVisible(), true);
  assert.equal(await page.locator('#language-title').innerText(), 'Elige tu idioma');
  assert.equal(await page.locator('#first-language option').count(), 5);
  assert.equal(await page.locator('#first-language option[value="de"]').innerText(), 'Deutsch');
  for (const [locale, title] of [['en', 'Choose your language'], ['es', 'Elige tu idioma'], ['pt-BR', 'Escolha seu idioma'], ['de', 'Wähle deine Sprache']]) {
    await page.selectOption('#first-language', locale);
    assert.equal(await page.locator('#language-title').innerText(), title);
  }
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, 'language-first-launch-de.png') });
  }
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#language-dialog').isVisible(), true);
  await page.selectOption('#first-language', 'fr');
  assert.equal(await page.locator('#language-title').innerText(), 'Choisissez votre langue');
  assert.equal(await page.locator('#language-continue').innerText(), 'Continuer');
  await page.click('#language-continue'); await page.locator('#language-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.__languageWrites), ['fr']);
  await page.reload(); await page.evaluate(() => window.kaiLanguageReady);
  assert.equal(await page.locator('#language-dialog').isVisible(), false);
  assert.equal(await page.getAttribute('html', 'lang'), 'fr');
  await page.fill('#input', 'Settings');
  await page.click('#nav-settings'); await page.waitForSelector('#view-settings:not([hidden])');
  await page.selectOption('#interface-language', 'de');
  await page.waitForFunction(() => document.documentElement.lang === 'de');
  assert.equal(await page.locator('#nav-settings span').innerText(), 'Einstellungen');
  assert.equal(await page.locator('#workspace-title').innerText(), 'Einstellungen');
  assert.equal(await page.inputValue('#input'), 'Settings', 'unsent user text survives switching');
  if (process.env.KAI_MASCOT_QA_DIR) { fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, 'language-settings-de.png') }); }
  assert.deepEqual(errors, []);
});
test('dynamic UI translates without changing user content, tokens, attributes, values or selected options', { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const { page } = await fixture(t, { language: 'es', selected: true });
  const result = await page.evaluate(async () => {
    const host = document.createElement('div'); host.id = 'i18n-fixture'; document.body.append(host);
    const user = 'Settings', address = '1SettingsWalletAddress';
    host.innerHTML = KaiI18n.html`<h2>Settings</h2><p>${user}</p><code>${address}</code><input value="${user}" placeholder="Password"><select><option value="run" ${true ? 'selected' : ''}>Run</option><option value="cancel">Cancel</option></select><button title="Copy">Copy</button>`;
    const status = document.createElement('p'); host.append(status);
    KaiI18n.setText(status, KaiI18n.message`Downloading model… ${42}%`);
    await new Promise(resolve => setTimeout(resolve, 0));
    const before = { heading: host.querySelector('h2').textContent, user: host.querySelector('p').textContent, address: host.querySelector('code').textContent, input: host.querySelector('input').value, option: host.querySelector('select').value, status: status.textContent };
    KaiI18n.setLanguage('de');
    const after = { heading: host.querySelector('h2').textContent, user: host.querySelector('p').textContent, status: status.textContent, title: host.querySelector('button').title };
    KaiI18n.setLanguage('en');
    KaiI18n.setText(status, 'Could not save the language. Please try again.');
    KaiI18n.setText(status, '');
    KaiI18n.setLanguage('fr');
    const cleared = status.textContent;
    KaiI18n.setText(status, 'Settings'); status.textContent = 'new external status';
    KaiI18n.setLanguage('en');
    return { before, after, cleared, external: status.textContent, english: host.querySelector('h2').textContent };
  });
  assert.deepEqual(result.before, { heading: 'Configuración', user: 'Settings', address: '1SettingsWalletAddress', input: 'Settings', option: 'run', status: 'Descargando modelo… 42%' });
  assert.deepEqual(result.after, { heading: 'Einstellungen', user: 'Settings', status: 'Modell wird heruntergeladen… 42%', title: 'Kopieren' });
  assert.equal(result.english, 'Settings');
  assert.equal(result.cleared, '');
  assert.equal(result.external, 'new external status');
});
test('failed preference write keeps first launch open and permits retry', { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => { window.__failLanguageSave = true; });
  await page.click('#language-continue');
  await page.waitForFunction(() => document.getElementById('language-error').textContent.length > 0);
  assert.equal(await page.locator('#language-dialog').isVisible(), true);
  assert.equal(await page.locator('#language-continue').isEnabled(), true);
  await page.evaluate(() => { window.__failLanguageSave = false; });
  await page.click('#language-continue'); await page.locator('#language-dialog').waitFor({ state: 'hidden' });
});
