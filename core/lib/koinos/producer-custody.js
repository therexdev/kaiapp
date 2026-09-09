"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const { Signer, Transaction, utils } = require("koilib");
const { parseAmount, cmpSats } = require("./format");
const keyText = value => value ? Buffer.from(value, "base64").toString("base64url") : null;
const externalMode = settings => settings.get("producer.mode", "local") === "external";
const producerAddress = (settings, wallet) => externalMode(settings) ? settings.get(`producer.addresses.${settings.get("network", "mainnet")}`, "") : wallet.address;

class ProducerCustody {
  constructor({ settings, state, wallet, chain, nodeMgr, rewards }) { Object.assign(this, { settings, state, wallet, chain, nodeMgr, rewards }); }
  config() { return { mode: externalMode(this.settings) ? "external" : "local", address: producerAddress(this.settings, this.wallet), localWalletAddress: this.wallet.address || null }; }
  requireExternal() { if (!externalMode(this.settings)) throw new Error("Select External/cold producer wallet first."); if (!this.config().address) throw new Error("Set a watch-only producer address for this network."); }
  requireLocal() { if (externalMode(this.settings)) throw new Error("External producer mode never signs with the earning wallet. Use External signing in Node setup."); }
  hotPublicKey() {
    const pub = keyText(this.nodeMgr.readProducerPublicKey(this.chain.network().id));
    if (!externalMode(this.settings)) return pub;
    const file = path.join(this.nodeMgr.dirs(this.chain.network().id).producerKeyDir, "private.key");
    if (!fs.existsSync(file) && !pub) return null;
    try {
      const signer = Signer.fromWif(fs.readFileSync(file, "utf8").trim());
      if (utils.encodeBase64url(signer.publicKey) === pub) return pub;
    } catch { /* no secret or parser details in UI errors */ }
    throw new Error("Hot key files are missing or inconsistent. Stop the node and use Generate hot key to restore the public file from its private key.");
  }
  async stopped() {
    if (this.rewards._busy) throw new Error("Wait for the current reward operation to finish.");
    const s = await this.nodeMgr.status(this.chain.network().id);
    if (!s.docker?.ok || s.isRunning || s.op?.running) throw new Error("Stop the node and wait for it to finish before changing producer custody or keys. Docker must be available to verify it is stopped.");
  }
  async configure({ mode, address }) {
    if (!["local", "external"].includes(mode)) throw new Error("Choose local or external producer custody.");
    address = String(address || "").trim();
    if (mode === "external" && !this.chain.isValidAddress(address)) throw new Error("Enter a valid watch-only Koinos address.");
    if (mode === "external" && address === this.wallet.address) throw new Error("This address already has a private key in the local earning wallet. Choose a separately controlled external address.");
    await this.stopped();
    if (this.rewards._busy) throw new Error("Wait for the current reward operation to finish.");
    this.rewards.configure({ enabled: false });
    const addresses = { ...this.settings.get("producer.addresses", {}), ...(mode === "external" ? { [this.chain.network().id]: address } : {}) };
    this.settings.set("producer", { mode, addresses });
    this.state.set("producerDraft", null);
    return this.config();
  }
  async status() {
    const config = this.config(), filePublicKey = this.hotPublicKey();
    let registeredPublicKey = null, verificationError = null;
    if (config.address) {
      try { registeredPublicKey = keyText(await this.chain.registeredPublicKey(config.address, { strict: true })); }
      catch { verificationError = "Could not verify registration on-chain. Check the network/RPC and retry."; }
    }
    return { ...config, filePublicKey, registeredPublicKey, matches: !!filePublicKey && filePublicKey === registeredPublicKey && !verificationError, verificationError,
      keyDirectory: this.nodeMgr.dirs(this.chain.network().id).producerKeyDir };
  }
  async key({ rotate = false, confirm = false } = {}) {
    this.requireExternal(); await this.stopped();
    const dir = this.nodeMgr.dirs(this.chain.network().id).producerKeyDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const priv = path.join(dir, "private.key"), pub = path.join(dir, "public.key");
    if (rotate && !confirm) throw new Error("Confirm rotation: production needs a new external registration before restarting.");
    let backup = null;
    if (rotate && fs.existsSync(priv)) {
      backup = path.join(dir, "key-backup-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
      fs.mkdirSync(backup, { mode: 0o700 });
      // Copy both before removing the current key. Never discard the old key.
      fs.copyFileSync(priv, path.join(backup, "private.key")); fs.chmodSync(path.join(backup, "private.key"), 0o600);
      if (fs.existsSync(pub)) fs.copyFileSync(pub, path.join(backup, "public.key"));
      fs.unlinkSync(priv);
    }
    if (!fs.existsSync(priv)) {
      const signer = new Signer({ privateKey: crypto.randomBytes(32) });
      fs.writeFileSync(priv, signer.getPrivateKey("wif") + "\n", { flag: "wx", mode: 0o600 });
    }
    const signer = Signer.fromWif(fs.readFileSync(priv, "utf8").trim());
    const publicKey = utils.encodeBase64url(signer.publicKey);
    fs.writeFileSync(pub, publicKey + "\n", { mode: 0o600 });
    this.state.set("producerDraft", null);
    return { publicKey, keyDirectory: dir, backupDirectory: backup };
  }
  async prepare({ action, amount, to, token = "koin" }) {
    this.requireExternal();
    const { address } = this.config(), network = this.chain.network().id;
    const provider = this.chain.provider(), rcLimit = await this.chain._rcLimit(provider, address);
    const tx = new Transaction({ provider, options: { payer: address, rcLimit } });
    const summary = { action, producer: address, network };
    if (action === "register") {
      const publicKey = this.hotPublicKey();
      if (!publicKey) throw new Error("Generate the hot production key first.");
      const pob = await this.chain._contract("pob", { provider });
      await tx.pushOperation(pob.functions.register_public_key, { producer: address, public_key: publicKey });
      summary.publicKey = publicKey;
    } else if (action === "burn" || action === "transfer") {
      const amountSat = parseAmount(amount);
      if (cmpSats(amountSat, "0") <= 0) throw new Error("Amount must be positive.");
      if (!["koin", "vhp"].includes(token)) throw new Error("Choose KOIN or VHP.");
      const balances = await this.chain.balances(address);
      if (cmpSats(amountSat, balances[action === "burn" ? "koin" : token]) > 0) throw new Error("Insufficient balance.");
      Object.assign(summary, { amount: String(amount), token: action === "burn" ? "koin" : token, to: action === "burn" ? address : to });
      if (action === "burn") {
        this.chain._assertMana(amountSat, balances.mana, "burn");
        const pob = await this.chain._contract("pob", { provider });
        if (await this.chain._isAllowanceToken(provider)) {
          const koin = await this.chain._contract("koin", { provider }), addrs = await this.chain.resolveContracts();
          await tx.pushOperation(koin.functions.approve, { owner: address, spender: addrs.pob, value: amountSat });
        }
        await tx.pushOperation(pob.functions.burn, { token_amount: amountSat, burn_address: address, vhp_address: address });
      } else {
        if (!this.chain.isValidAddress(to)) throw new Error("Invalid recipient address.");
        if (token === "koin") this.chain._assertMana(amountSat, balances.mana, "send");
        const contract = await this.chain._contract(token, { provider });
        await tx.pushOperation(contract.functions.transfer, { from: address, to, value: amountSat });
      }
    } else throw new Error("Choose register, burn or transfer.");
    await tx.prepare();
    const draft = { format: "kai-producer-transaction-v1", expiresAt: Date.now() + 15 * 60000, summary, transaction: tx.transaction };
    this.state.set("producerDraft", draft);
    return draft;
  }
  async broadcast({ transaction, confirm }) {
    this.requireExternal();
    if (confirm !== true) throw new Error("Review and confirm the signed transaction before broadcasting.");
    const draft = this.state.get("producerDraft", null);
    if (!draft || draft.expiresAt < Date.now()) throw new Error("The draft expired. Prepare and sign a fresh transaction.");
    if (draft.summary.network !== this.chain.network().id || draft.summary.producer !== this.config().address) throw new Error("Producer or network changed. Prepare a new draft.");
    if (!transaction || JSON.stringify(transaction).length > 100000 || Object.keys(transaction).some(k => !["id", "header", "operations", "signatures"].includes(k))) throw new Error("Paste only the signed transaction JSON, never a private key.");
    const { signatures, ...unsigned } = transaction, { signatures: _ignored, ...expected } = draft.transaction;
    if (!isDeepStrictEqual(unsigned, expected)) throw new Error("Signed transaction differs from the prepared draft. Nothing was broadcast.");
    if (!Array.isArray(signatures) || signatures.length !== 1 || typeof signatures[0] !== "string" || signatures[0].length > 100) throw new Error("A single external producer signature is required.");
    const signers = await Signer.recoverAddresses(transaction);
    if (!signers.includes(this.config().address)) throw new Error("The signature does not belong to the external producer address.");
    if (draft.summary.action === "register" && draft.summary.publicKey !== this.hotPublicKey()) throw new Error("The hot key changed. Prepare a new registration.");
    const provider = this.chain.provider();
    if (await provider.getChainId() !== transaction.header.chain_id || await provider.getNextNonce(this.config().address) !== transaction.header.nonce) throw new Error("Network or account nonce changed. Prepare and sign a new draft.");
    // Consume before sending: an uncertain network response must not auto-replay.
    this.state.set("producerDraft", null);
    const tx = new Transaction({ provider, transaction });
    await tx.send();
    return { txId: transaction.id, confirmed: false, note: "Submitted. Verify confirmation in the explorer; registration must be checked on-chain before starting production." };
  }
}
module.exports = { ProducerCustody, externalMode, producerAddress };
