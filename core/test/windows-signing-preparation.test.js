"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process"), yaml = require("js-yaml");
const script = path.resolve(__dirname, "../../scripts/prepare-windows-signing.ps1");
const native = { skip: process.platform !== "win32" };
function fixture(t, exportsCommand = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-signing-preparation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, "modules"), moduleDir = path.join(modules, "TrustedSigning", "0.5.0");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "TrustedSigning.psm1"), exportsCommand ? "function Invoke-TrustedSigning { throw 'A test must never sign a file.' }\nExport-ModuleMember -Function Invoke-TrustedSigning\n" : "Export-ModuleMember -Function @()\n");
  fs.writeFileSync(path.join(moduleDir, "TrustedSigning.psd1"), "@{ RootModule = 'TrustedSigning.psm1'; ModuleVersion = '0.5.0'; GUID = '977670d7-b44c-45a7-b618-cc38417da302'; FunctionsToExport = " + (exportsCommand ? "@('Invoke-TrustedSigning')" : "@()") + "; CmdletsToExport = @(); VariablesToExport = @(); AliasesToExport = @() }\n");
  const run = args => spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8", env: { ...process.env, PSModulePath: modules }, timeout: 30000 });
  const quoted = value => "'" + value.replace(/'/g, "''") + "'";
  return { root, modules, run, quoted };
}

test("Test packaging verifies module installation before exposing signing credentials or building installers", () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, "../../.github/workflows/test-release.yml"), "utf8"));
  const steps = workflow.jobs.windows.steps;
  const preparation = steps.findIndex(s => s.run === "./scripts/prepare-windows-signing.ps1");
  const credentials = steps.findIndex(s => s.run?.includes("configure-windows-signing.js"));
  const build = steps.findIndex(s => s.run?.includes("npm run dist -- --win --publish never"));
  assert.ok(preparation >= 0 && credentials > preparation && build > credentials);
  assert.equal(steps[preparation].env, undefined, "Module preparation receives no Azure credentials");
  assert.ok(steps.some(s => s.run?.includes("core/test/windows-signing-preparation.test.js")));
});

test("native signing prerequisite proves explicit import and fresh-process autoload without signing", native, t => {
  const f = fixture(t);
  for (const mode of ["-VerifyOnly", "-AutoloadOnly"]) {
    const result = f.run(["-File", script, mode]);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /TrustedSigning 0\.5\.0: .* verified/);
  }
});

test("native signing prerequisite rejects installed modules missing the actual signing command", native, t => {
  const f = fixture(t, false);
  for (const mode of ["-VerifyOnly", "-AutoloadOnly"]) assert.notEqual(f.run(["-File", script, mode]).status, 0);
});

test("native preparation retries a non-terminating installer error but requires the command before success", native, t => {
  const f = fixture(t), wrapper = path.join(f.root, "retry.ps1");
  fs.writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
. ${f.quoted(script)}
$script:attempts = 0
function Get-PackageProvider { return @{ Name = 'NuGet' } }
function Install-Module { $script:attempts++; if ($script:attempts -eq 1) { Write-Error 'Isolated non-terminating installer failure' } }
function Start-Sleep {}
Initialize-KaiTrustedSigning
if ($script:attempts -ne 2) { throw 'Expected exactly two install attempts' }
Write-Output 'INSTALL-RETRY-VERIFIED'
`);
  const result = f.run(["-File", wrapper]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /INSTALL-RETRY-VERIFIED/);
});

test("native preparation stops after bounded failures and never proceeds with a missing signer", native, t => {
  const f = fixture(t, false), wrapper = path.join(f.root, "reject.ps1");
  fs.writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
. ${f.quoted(script)}
$script:attempts = 0
function Get-PackageProvider { return @{ Name = 'NuGet' } }
function Install-Module { $script:attempts++ }
function Start-Sleep {}
try { Initialize-KaiTrustedSigning } catch {
  if ($script:attempts -ne 3) { throw 'Expected three bounded attempts' }
  Write-Output 'MISSING-SIGNER-REJECTED'
  exit 42
}
throw 'Missing signer unexpectedly accepted'
`);
  const result = f.run(["-File", wrapper]);
  assert.equal(result.status, 42, result.stderr); assert.match(result.stdout, /MISSING-SIGNER-REJECTED/);
});
