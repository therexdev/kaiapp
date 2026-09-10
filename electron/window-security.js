"use strict";

function trustedMainDocument(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.origin === origin && ["/", "/index.html"].includes(url.pathname);
  } catch { return false; }
}

function protectNavigation(contents, origin, openExternal) {
  const guard = (event, value) => {
    let url;
    try { url = new URL(value); } catch { event.preventDefault(); return; }
    if (url.origin === origin && ["/", "/index.html"].includes(url.pathname)) return;
    event.preventDefault();
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) Promise.resolve(openExternal(url.href)).catch(() => {});
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-attach-webview", event => event.preventDefault());
}

module.exports = { trustedMainDocument, protectNavigation };
