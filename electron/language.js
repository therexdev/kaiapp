'use strict';
const { normalize, detect, languages } = require('../ui/i18n');
const { trustedMainDocument } = require('./window-security');
function registerLanguage({ ipcMain, app, store, getMainWindow, getMascotWindow, origin, onChange = () => {} }) {
  const status = () => ({ language: normalize(store.get('interfaceLanguage')) || detect(app.getPreferredSystemLanguages?.() || [app.getLocale()]), selected: !!normalize(store.get('interfaceLanguage')) });
  const trusted = event => {
    if (trustedMainDocument(event, getMainWindow(), origin)) return true;
    const mascot = getMascotWindow();
    return !!mascot && !mascot.isDestroyed() && event.sender === mascot.webContents && event.senderFrame === mascot.webContents.mainFrame && event.senderFrame.url === origin + '/mascot.html';
  };
  ipcMain.handle('shell:language', event => {
    if (!trusted(event)) throw new Error('Desktop window access denied');
    return status();
  });
  ipcMain.handle('shell:set-language', (event, language) => {
    if (!trustedMainDocument(event, getMainWindow(), origin)) throw new Error('Desktop window access denied');
    if (!languages.some(l => l.code === language)) throw new Error('Unsupported interface language');
    store.set('interfaceLanguage', language);
    for (const window of [getMainWindow(), getMascotWindow()]) if (window && !window.isDestroyed()) window.webContents.send('shell:language-changed', status());
    onChange(language);
    return status();
  });
  return { status };
}
module.exports = { registerLanguage };
