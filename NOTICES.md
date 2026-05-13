# Third-party software notices

Sparrow is distributed under the MIT License (see `LICENSE`). The app
bundles or links against the following third-party components. Each
is used under the terms of its own license; this file is the
attribution required by those licenses. Refer to each project's
repository for the full license text.

## Application framework

| Component | License | Upstream |
|---|---|---|
| Tauri (`tauri`) | MIT OR Apache-2.0 | <https://github.com/tauri-apps/tauri> |
| `tauri-plugin-opener` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-dialog` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-fs` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-updater` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-process` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| `@tauri-apps/api` | MIT OR Apache-2.0 | <https://github.com/tauri-apps/tauri/tree/dev/packages/api> |
| Vue 3 (`vue`) | MIT | <https://github.com/vuejs/core> |

## Editor and UI

| Component | License | Upstream |
|---|---|---|
| Monaco Editor (`monaco-editor`) | MIT | <https://github.com/microsoft/monaco-editor> |
| xterm.js (`@xterm/xterm`) | MIT | <https://github.com/xtermjs/xterm.js> |
| `@xterm/addon-fit` | MIT | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit> |
| Tabulator (`tabulator-tables`) | MIT | <https://github.com/olifolkerd/tabulator> |
| Fabric.js (`fabric`) | MIT | <https://github.com/fabricjs/fabric.js> |
| Lucide icons (`lucide-vue-next`) | ISC | <https://github.com/lucide-icons/lucide> |

## Content rendering and file formats

| Component | License | Upstream |
|---|---|---|
| markdown-it | MIT | <https://github.com/markdown-it/markdown-it> |
| SheetJS Community Edition (`xlsx`) | Apache-2.0 | <https://github.com/SheetJS/sheetjs> |
| jsPDF (`jspdf`) | MIT | <https://github.com/parallax/jsPDF> |

## Spell check

| Component | License | Upstream |
|---|---|---|
| `cspell-trie-lib` | MIT | <https://github.com/streetsidesoftware/cspell> |
| `an-array-of-english-words` | Unlicense (public domain dedication) | <https://github.com/words/an-array-of-english-words> |

## Rust crates

| Crate | License | Upstream |
|---|---|---|
| `reqwest` | MIT OR Apache-2.0 | <https://github.com/seanmonstar/reqwest> |
| `portable-pty` | MIT | <https://github.com/wez/wezterm/tree/main/pty> |
| `serde`, `serde_json` | MIT OR Apache-2.0 | <https://github.com/serde-rs/serde> |

## License texts

Most of the projects above use one or more of these standard licenses:

- **MIT** — <https://opensource.org/licenses/MIT>
- **Apache License 2.0** — <https://www.apache.org/licenses/LICENSE-2.0>
- **ISC** — <https://opensource.org/licenses/ISC>
- **Unlicense** — <https://unlicense.org/>

For dual-licensed components (most Tauri and Rust crates above), the
recipient may choose either license at their option. Sparrow's
distribution preserves each upstream project's `LICENSE` /
`COPYRIGHT` files inside the dependency tree (`node_modules/` and
`src-tauri/target/`); the table here exists to make the attribution
obligation visible in the source tree itself.

## Transitive dependencies

The components above pull in many transitive dependencies, each
under its own license. A complete machine-readable list can be
regenerated at any time:

```bash
# JavaScript side — produces an SBOM with every npm package + license
npx license-checker --summary
npx license-checker --json > sbom.npm.json

# Rust side — produces a list of every crate + license
cargo install cargo-license   # one-time
(cd src-tauri && cargo license --json) > sbom.cargo.json
```

If you redistribute Sparrow's binaries (rather than its source), it's
good practice to ship the generated SBOMs alongside this `NOTICES.md`
so end users can audit the full dependency closure.
