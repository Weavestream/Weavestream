/// <reference types="vite/client" />

// Pulls in Vite's ambient declarations for asset imports (`*.svg`,
// `*.png`, `*.woff2`, …) and `import.meta.env`.
//
// A triple-slash reference rather than relying on `types: ["vite/client"]`
// in tsconfig: under `moduleResolution: "Bundler"` that entry does not
// reliably resolve Vite's `./client` exports subpath, so the asset module
// declarations went missing and `import logo from '…svg'` failed to
// typecheck. This is also the file Vite's own scaffold generates.
