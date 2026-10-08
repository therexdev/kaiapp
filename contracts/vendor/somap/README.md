# somap used by the contract test VM

Source: somap 0.5.14 by Ulf Schneider, https://github.com/ulfschneider/somap.
The published package declares the MIT license (preserved in upstream-package.json).

The runtime is copied unchanged except for trailing whitespace and a final newline.
It has no imports. Its npm dependency is unused by this sorted-map implementation
but installs a complete package manager and vulnerable bundled network utilities.
This local package removes that dependency and upstream development-only scripts.
The Koinos mock VM still executes the original SoMap and SoSet algorithms.

Original somap.js SHA-256: `7c22938a3fa30648171c23d623ea903383d1bee2be6eb029aab81a45fe272597`.
Vendored somap.js SHA-256: `c1cb96140da75d22fb0685dd1b5221f9df8e2e68fe8afe5134a89b454f0e4cb1`.

Both contract projects override somap to this directory. Their full VM tests and
compiled custody runtime probe validate the dependency in its actual use. Do not
reintroduce npm merely to update this dependency. All dependency audit gates stay
enabled. This package is build/test tooling and is not shipped in the desktop app.
