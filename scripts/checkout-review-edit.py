"""One-off, hash-guarded checkout fix, applied only to an isolated review branch."""
import hashlib
from pathlib import Path
import sys

UI = Path('ui/product-experience.js')
TEST = Path('core/test/purchase-wallet.browser.test.js')
EXPECTED_UI = '9ffaf41753ec0ba59ab2fa9d7e78e17087b21640'
EXPECTED_TEST = '605e484ad3b434b9ab787b80d5eb4697dad22dac'

def read_verified(path, expected):
    data = path.read_bytes()
    digest = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if digest != expected:
        raise SystemExit(f'{path} changed: expected {expected}, found {digest}; stopping without overwriting it')
    return data.decode('utf-8')

TESTS = r'''

test("checkout failure stays visible through background price refresh", options, async t => {
  const { page, buy, status, count } = await fixture(t);
  const reason = "This purchase exceeds the configured payment limit";
  await page.evaluate(reason => { window.purchasePreviewFailure = reason; }, reason);
  await buy.click();
  await page.waitForFunction(() => window.purchaseCalls.some(c => c.action === "purchase-preview") && !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await status.textContent(), reason);
  const estimates = await count("purchase-estimate");
  // Returning focus triggers background reads, not a new purchase intent.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(before => window.purchaseCalls.filter(c => c.action === "purchase-estimate").length > before && !document.getElementById("product-quote-refresh").disabled, estimates);
  assert.equal(await status.textContent(), reason, "a display-only price refresh must not erase a checkout failure");
  assert.equal(await count("purchase-approve"), 0);
  await page.evaluate(() => { window.purchasePreviewFailure = null; });
  await buy.click();
  await page.waitForFunction(() => window.purchaseCalls.some(c => c.action === "purchase-approve"));
  assert.equal(await count("purchase-approve"), 1, "an explicit retry still reaches exactly one wallet review");
  assert.equal(await page.evaluate(() => window.purchaseCalls.find(c => c.action === "purchase-approve").input), "fixture-quote");
});

test("changed purchase amount gives a visible pause instead of resetting", options, async t => {
  const { page, buy, status, count } = await fixture(t);
  await page.evaluate(() => { window.holdQuote = true; });
  await buy.click(); await page.waitForFunction(() => !!window.finishQuote);
  await page.locator("#product-usd-amount").fill("5");
  await page.evaluate(() => { window.holdQuote = false; window.finishQuote(); });
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.match(await status.textContent(), /Purchase paused because the amount or payment wallet changed/);
  assert.equal(await count("purchase-approve"), 0, "the old amount must never proceed to wallet review");
  assert.equal(await count("purchase-preview"), 1, "changing the selection must not retry a purchase automatically");
});
'''

if len(sys.argv) != 2 or sys.argv[1] not in ('tests', 'fix'):
    raise SystemExit('Usage: checkout-review-edit.py tests|fix')
if sys.argv[1] == 'tests':
    read_verified(UI, EXPECTED_UI)
    text = read_verified(TEST, EXPECTED_TEST)
    TEST.write_text(text + TESTS, encoding='utf-8')
    raise SystemExit(0)

text = read_verified(UI, EXPECTED_UI)
def replace(old, new):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Expected one match, found {count}: {old[:100]!r}; no source written')
    text = text.replace(old, new, 1)

replace('let previousLocalPurchase = false, modelPricingRead = null;',
        'let previousLocalPurchase = false, modelPricingRead = null, purchaseFailure = "";')
replace('  function invalidateQuote(text) {',
        '  // Background estimates may update the price, but never erase a failed checkout.\n'
        '  function showPurchaseFailure(error) {\n'
        '    purchaseFailure = message(error); $("product-quote-state").textContent = purchaseFailure;\n'
        '  }\n'
        '  function invalidateQuote(text) {')
replace('    if (text) $("product-quote-state").textContent = text;',
        '    if (text) $("product-quote-state").textContent = purchaseFailure || text;')
replace('\n\n  }\n  async function refreshPurchaseWallet() {',
        '\n    if (!saved && purchaseFailure) $("product-quote-state").textContent = purchaseFailure;\n'
        '  }\n  async function refreshPurchaseWallet() {')
replace('      $("product-quote-state").textContent = result.estimate.priceDetails.referenceKind === "market-estimate"',
        '      if (!purchaseFailure) $("product-quote-state").textContent = result.estimate.priceDetails.referenceKind === "market-estimate"')
replace('      $("product-quote-state").textContent = message(error) + " Price refresh retries automatically; Buy credits also checks again.";',
        '      if (!purchaseFailure) $("product-quote-state").textContent = message(error) + " Price refresh retries automatically; Buy credits also checks again.";')
replace('  function pack() {\n    const raw = selectedAmount();',
        '  function pack() {\n    purchaseFailure = "";\n    const raw = selectedAmount();')
replace('$("product-purchase-check").addEventListener("click", async () => { await refreshPurchases(); schedulePreview(0); });',
        '$("product-purchase-check").addEventListener("click", async () => { purchaseFailure = ""; await refreshPurchases(); schedulePreview(0); });')
replace('const stop = $("product-purchase-stop"); stop.disabled = true; paymentOperation++;',
        'const stop = $("product-purchase-stop"); stop.disabled = true; paymentOperation++; purchaseFailure = "";')
replace('    if (approving || quoting || $("product-quote-refresh").disabled) return;\n    const operation',
        '    if (approving || quoting || $("product-quote-refresh").disabled) return;\n    purchaseFailure = "";\n    const operation')
replace('    const selectionCurrent = () => current() && revision === quoteRevision && key === walletKey();',
        '    const selectionCurrent = () => current() && revision === quoteRevision && key === walletKey() && usd === selectedAmount();\n'
        '    $("product-quote-state").textContent = "Checking the exact KOIN price before wallet approval…";')
replace('      if (!selectionCurrent()) return;\n      showQuote(r?.quote, key);',
        '      if (!current()) return;\n'
        '      if (!selectionCurrent()) throw Error("Purchase paused because the amount or payment wallet changed. Check your selection, then choose Buy credits again.");\n'
        '      const approvalQuote = r?.quote;\n'
        '      showQuote(approvalQuote, key);')
replace('      if (!selectionCurrent() || purchaseInfo.localPurchase || purchaseInfo.activation !== "ready" || !walletReady()) return;',
        '      if (!current()) return;\n'
        '      if (!selectionCurrent()) throw Error(walletError || "Purchase paused because the amount or payment wallet changed. Check your selection, then choose Buy credits again.");\n'
        '      if (purchaseInfo.localPurchase) throw Error(purchaseInfo.localPurchase.detail || "An earlier payment needs checking before a new purchase. Use Continue payment or Account help.");\n'
        '      if (purchaseInfo.activation !== "ready") throw Error(purchaseInfo.blocked || "Credit purchases are currently unavailable. Try again.");\n'
        '      if (!walletReady()) throw Error(walletError || "Your payment wallet could not be verified. Open Wallet, then try Buy credits again.");')
replace('      if (Date.now() >= quote.expiresAt) throw Error("The price expired before payment. Try Buy credits again.");',
        '      if (Date.now() >= approvalQuote.expiresAt) throw Error("The price expired before payment. Try Buy credits again.");')
replace('      if (amountAtoms(purchaseWallet.koin) < amountAtoms(quote.koin)) throw Error(',
        '      if (amountAtoms(purchaseWallet.koin) < amountAtoms(approvalQuote.koin)) throw Error(')
replace('      const result = await window.kaiKoinTestBridge.run("purchase-approve", quote.id);',
        '      const result = await window.kaiKoinTestBridge.run("purchase-approve", approvalQuote.id);')
replace('    } catch (error) { if (current()) $("product-quote-state").textContent = message(error); }',
        '    } catch (error) { if (current()) showPurchaseFailure(error); }')
replace('    purchaseInfo = { activation: "loading" }; invalidateQuote("Account changed.',
        '    purchaseFailure = ""; purchaseInfo = { activation: "loading" }; invalidateQuote("Account changed.')
replace('if (view === "buy-credits") { refreshPurchases().then(() => schedulePreview(0)); refreshModelPricing(); }',
        'if (view === "buy-credits") { purchaseFailure = ""; refreshPurchases().then(() => schedulePreview(0)); refreshModelPricing(); }')
UI.write_text(text, encoding='utf-8')
notes = Path('docs/TEST_WHATS_NEW.md')
notes.write_text('## Clear purchase failures instead of silent checkout resets\n\n'
                 '- Buy credits keeps the actual checkout error visible while read-only prices refresh. An explicit retry or changed selection clears it.\n'
                 '- A changed amount, payment wallet, account availability or saved payment stops the new purchase with a reason instead of silently returning before wallet approval.\n'
                 '- Wallet review uses the exact verified quote returned for that click. Spending limits, native approval, saved-payment recovery and transaction submission policy are unchanged.\n\n' + notes.read_text(encoding='utf-8'), encoding='utf-8')
print('Applied checkout-only patch; provider model selection, prices, wallet authority and release feeds unchanged.')
