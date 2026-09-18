"use strict";
function renderMasterApiView() {
  const cfg = S.appInfo.settings.masterApi || {};
  $("#view-master-api").innerHTML = `<h1>Master node API</h1>
    <p class="lead">Serve cached, read-only blockchain data from this node.</p>
    <div class="card"><label class="field"><span><input id="ma-enabled" type="checkbox" ${cfg.enabled ? "checked" : ""}> Enable read-only endpoint</span></label>
    <label class="field"><span>Private local node RPC</span><input id="ma-rpc" value="${esc(cfg.rpcUrl || "http://127.0.0.1:8085")}"></label>
    <label class="field"><span>API port</span><input id="ma-port" type="number" value="${esc(cfg.port || 41110)}"></label>
    <button id="ma-save" class="btn primary">Save API settings</button>
    <p class="hint">For other apps to connect, configure an HTTPS reverse proxy or outbound tunnel to this port. Keep Core, wallet and raw node RPC ports private.</p>
    <p class="hint">Indexes the last 28,800 finalized blocks. Initial indexing and stale-node data return HTTP 503. Counts cover observed producers, not all VHP holders or connected peers.</p></div>
    <div class="card"><h2>Endpoint status</h2><pre id="ma-status" style="white-space:pre-wrap"></pre></div>`;
  $("#ma-save").addEventListener("click",async () => { try {
    const saved = await call("masterApi:configure",{ enabled:$("#ma-enabled").checked, rpcUrl:$("#ma-rpc").value.trim(), port:Number($("#ma-port").value) });
    S.appInfo.settings.masterApi = saved.config;
    toast("Node API settings saved","good"); await refreshMasterApi();
  } catch(e) { toast(e.message,"bad"); } });
  void refreshMasterApi();
}
async function refreshMasterApi() {
  const el = $("#ma-status"); if (!el) return;
  try {
    const s = await call("masterApi:status"), p = s.summary;
    el.textContent = `${s.listening ? "Listening" : "Stopped"} · ${s.producerUrl}\n${s.error || p?.error || ""}\n${p ? `Indexed ${p.indexed_height} / ${p.finalized_height} finalized · ${p.total_blocks} blocks\nReady: ${p.available ? "yes" : "no"}\nChain ID: ${p.chain_id}\nUpdated: ${fmtTime(p.updated_at)}` : "No data yet. Enable the API with the local node fully synchronized."}`;
  } catch(e) { el.textContent = e.message; }
}
