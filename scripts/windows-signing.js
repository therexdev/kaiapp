"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
const { parseDn } = require("builder-util-runtime");

// Pin the existing public identity, not Azure's short-lived certificate thumbprint.
// Windows calls the state field S (OpenSSL calls it ST).
const PUBLISHER = "CN=Michael Milas, O=Michael Milas, L=Bennington, S=ne, C=US";

function publisherMatches(subject) {
  const normalize = value => new Map([...parseDn(value || "")].map(([k, v]) => [k === "ST" ? "S" : k, v]));
  const expected = normalize(PUBLISHER), actual = normalize(subject);
  return expected.size === actual.size && [...expected].every(([k, v]) => actual.get(k) === v);
}

function configureSigning(pkg, env) {
  const required = ["AZ_ACCOUNT", "AZ_PROFILE", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
  const missing = required.filter(key => !String(env[key] || "").trim());
  if (missing.length) throw new Error(`Windows signing is required. Missing configuration: ${missing.join(", ")}`);
  const result = structuredClone(pkg);
  const win = result.build.win;
  if (win.signtoolOptions) throw new Error("Remove the conflicting signtoolOptions before enabling Azure signing");
  win.forceCodeSigning = true;
  win.signExecutable = true;
  win.signAndEditExecutable = true;
  win.verifyUpdateCodeSignature = true;
  win.azureSignOptions = {
    codeSigningAccountName: env.AZ_ACCOUNT,
    certificateProfileName: env.AZ_PROFILE,
    endpoint: env.AZ_ENDPOINT || "https://eus.codesigning.azure.net",
    publisherName: PUBLISHER,
    fileDigest: "SHA256",
    timestampDigest: "SHA256",
    timestampRfc3161: "http://timestamp.acs.microsoft.com",
  };
  return result;
}

function assertSignature(record) {
  if (record.status !== "Valid" || record.signatureType !== "Authenticode") {
    throw new Error(`Untrusted or missing embedded signature: ${record.path} (${record.status})`);
  }
  if (!publisherMatches(record.subject)) throw new Error(`Unexpected Windows publisher: ${record.path}`);
  if (!record.timestampThumbprint) throw new Error(`Missing trusted timestamp: ${record.path}`);
  if (record.signToolExitCode !== 0) throw new Error(`SignTool verification failed: ${record.path}`);
}

function hash(file, algorithm = "sha256", encoding = "hex") {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

function artifactFiles(dir) {
  const names = fs.readdirSync(dir).filter(n => /\.(exe|blockmap)$/.test(n) || /^(latest|test)\.yml$/.test(n)).sort();
  const executables = names.filter(n => n.endsWith(".exe"));
  if (executables.length !== 2 || executables.filter(n => /[ -]Setup[ -]/.test(n)).length !== 1) {
    throw new Error("Expected exactly one Windows Setup installer and one portable executable");
  }
  if (names.filter(n => /^(latest|test)\.yml$/.test(n)).length !== 1) throw new Error("Expected exactly one Windows update feed");
  if (!names.some(n => n.endsWith(".exe.blockmap"))) throw new Error("Missing installer blockmap");
  return names;
}

function reportName(version) {
  if (!/^\d+\.\d+\.\d+(?:-test\.\d+\.\d+)?$/.test(version)) throw new Error("Invalid Windows release version");
  return `windows-signatures-${version}.json`;
}

// Publication jobs must use the exact bytes checked on Windows. This report is
// workflow evidence, not a replacement for an Authenticode signature.
function readVerifiedArtifacts(dir, identity) {
  const names = artifactFiles(dir);
  const feed = yaml.load(fs.readFileSync(path.join(dir, names.find(n => /^(latest|test)\.yml$/.test(n))), "utf8"));
  const file = reportName(feed.version);
  const report = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  if (!identity.commit || !identity.workflowRun || report.schemaVersion !== 1 || report.version !== feed.version ||
      report.commit !== identity.commit || report.workflowRun !== identity.workflowRun || report.publisher !== PUBLISHER) {
    throw new Error("Windows signature report does not match this release workflow");
  }
  if (!Array.isArray(report.artifacts) || report.artifacts.length !== names.length ||
      new Set(report.artifacts.map(a => a.name)).size !== names.length) throw new Error("Windows artifact coverage mismatch");
  for (const name of names) {
    const entry = report.artifacts.find(a => a.name === name);
    if (!entry || entry.sha256 !== hash(path.join(dir, name))) throw new Error(`Windows artifact changed after verification: ${name}`);
    if (name.endsWith(".exe")) {
      const signature = report.signatures?.find(s => s.path === name);
      if (!signature) throw new Error(`Missing signature evidence: ${name}`);
      assertSignature(signature);
    }
  }
  if (!Array.isArray(feed.files) || !feed.files.length || !feed.files.some(f => f.url === feed.path)) throw new Error("Invalid Windows update feed");
  for (const entry of feed.files) {
    const name = names.find(n => n.endsWith(".exe") && n.replace(/ /g, "-") === entry.url);
    if (!name || hash(path.join(dir, name), "sha512", "base64") !== entry.sha512 ||
        fs.statSync(path.join(dir, name)).size !== entry.size) throw new Error("Windows update feed does not match the verified installer");
  }
  if (feed.sha512 !== feed.files.find(f => f.url === feed.path).sha512) throw new Error("Windows update feed hash mismatch");
  return { report, reportFile: file, names };
}

module.exports = { PUBLISHER, publisherMatches, configureSigning, assertSignature, hash, artifactFiles, reportName, readVerifiedArtifacts };
