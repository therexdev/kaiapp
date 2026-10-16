"use strict";
(() => {
  const bridge = window.kaiKoinTestBridge;
  let info = { configured: false }, pending;
  const progress = text => { const node = document.getElementById("network-chat-status"); if (node) node.textContent = text; };
  const amount = value => { const n = BigInt(value); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
  async function refresh() {
    if (!bridge) return info;
    if (!pending) pending = bridge.run("chat-info").then(value => {
      if (!value || typeof value.enabled !== "boolean") throw Error("Network configuration unavailable");
      info = value;
      const recover = document.getElementById("network-recover"); if (recover) recover.hidden = !info.recoveryAvailable;
      return info;
    }).catch(error => { info = { ...info, configured: true, blocked: "Network configuration unavailable. Refresh your network account." }; throw error; }).finally(() => { pending = null; });
    return pending;
  }
  async function chatFetch(body, init) {
    const current = await refresh();
    if (!current.configured) throw Error("Connect your network account before using paid chat");
    if (current.blocked) throw Error(current.blocked);
    const signal = init.signal, stop = () => { bridge.run("stop").catch(() => {}); };
    signal?.throwIfAborted(); signal?.addEventListener("abort", stop, { once: true });
    progress("Checking your network account…");
    try {
      const result = await bridge.run("chat-completion", body);
      signal?.throwIfAborted();
      const charge = result.koin?.receipt?.usage?.amount;
      const warning = charge ? `${amount(charge)} KOIN · ${result.koin.state === "settled" ? "settled" : "verified usage, settlement pending"}` : "Verified network answer";
      const headers = { "x-kai-paid-request": result.id, "x-kai-buffered": "true" };
      progress(warning);
      if (body.stream === false) return Response.json(result, { headers });
      const frame = { model: "koinos-network", servedModel: result.servedModel, choices: [{ delta: { content: result.choices[0].message.content } }], warning };
      return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", { headers: { ...headers, "content-type": "text/event-stream" } });
    } catch (error) {
      const message = String(error.message || "Request interrupted. Send the original message again to recover it.")
        .replace(/^Error invoking remote method 'koin:test-payments': (?:Error: )?/, "");
      progress(message); throw Object.assign(new Error(message), { name: error.name });
    }
    finally { signal?.removeEventListener("abort", stop); window.dispatchEvent(new Event("kai-network-account-changed")); }
  }
  bridge?.onProgress?.(value => progress(String(value?.text || "")));
  document.getElementById("network-add-koin")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("kai-network-add-koin", { detail: document.getElementById("network-koin-amount").value }));
  });
  document.getElementById("network-account")?.addEventListener("click", () => window.dispatchEvent(new Event("kai-network-account")));
  document.getElementById("network-recover")?.addEventListener("click", () => window.dispatchEvent(new Event("kai-network-recover")));
  window.KaiNetwork = { refresh, chatFetch, get info() { return info; },
    acknowledge: id => bridge.run("chat-ack", id),
    recover: () => bridge.run("chat-recover"),
    paint() { const strip = document.getElementById("network-chat-account"); if (strip) strip.hidden = !(info.configured && document.getElementById("src-pick")?.value === "network"); } };
})();
