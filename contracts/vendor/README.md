# Contract test dependencies

`@as-covers/glue@0.2.0` requires `micromatch` and `yaml` at runtime but omits
them from its dependencies. Both contract projects declare these explicitly.
The `micromatch` name is an npm alias for pinned `picomatch@4.0.7`: coverage
uses only `isMatch(filePath, files)`, which picomatch provides, with our
`assembly/*.ts` patterns. This avoids micromatch's vulnerable braces dependency.
This is a scoped coverage-tool compatibility choice, not a general replacement
for every micromatch API.

`../verify-coverage-toolchain.js` checks resolution from each contract project's
own installation and exercises the actual coverage filter before contract tests.
Run a clean `npm ci --ignore-scripts`, `npm audit --audit-level=high`, `npm test`
and `npm run build` in each project when changing these dependencies. Do not
disable coverage or lower the audit gate to work around toolchain failures.

The separate [somap](somap/README.md) directory documents the unchanged runtime
vendored without its unused npm package-manager dependency.
