# Herder for VS Code

Completion and validation for [Herder](https://docs.herder.ispx.co/)
config repositories: forks of
[herder-public-configs](https://github.com/ispx-limited/herder-public-configs)
and anything shaped like them.

What it does, all against your own Herder:

- **Parameter path completion**, in YAML `devicePath:` / `path:` values
  and inside TypeScript string literals, served live from your fleet's
  discovered data models (`/api/v1/schema/parameters/suggest`).
  Completions are marked writable, read-only, or object; completing an
  object keeps the list open for the next segment.
- **Canonical name completion** for `canonical:` values, from the
  published reserved-canonicals registry, with the enforced `valueType`
  and the owning feature shown inline.
- **Exact-parity validation** of YAML documents and TypeScript scripts
  as you type, through `/api/v1/config/{domain}/validate`: the same
  registry-driven validator and script type-checker the sync path runs,
  cross-file errors included. No bundled compiler, nothing to drift.

## Setup

1. Set `herder.apiUrl` to your Herder API base URL.
2. Run **Herder: Set API Token**. The token needs read scope only; it
   is held in VS Code secret storage, never in settings or files.

YAML schema validation itself (structure, field types while editing) is
served separately by the published JSON Schemas; the one-line
`yaml.schemas` association for that ships in herder-public-configs and
works without this extension.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `herder.apiUrl` | empty | Base URL of the Herder API. Empty disables API-backed features |
| `herder.metaBaseUrl` | `https://docs.herder.ispx.co/schemas` | Where `kinds.json` and `reserved-canonicals.json` come from |
| `herder.scriptDomains` | provisioning, actions, topology, enrichment globs | Which config domain a `.ts` script validates against; first glob match wins, unmatched defaults to provisioning |
| `herder.validateOnChange` | `true` | Validate the buffer as you type (debounced), not only on save |

## How validation routes

A YAML buffer validates against the domain of each `apiVersion` it
contains, once per distinct domain, so multi-document mixed-kind files
(the herder-public-configs convention) validate whole. A script buffer
is sent with its repo-relative path as `name`, which makes the
validator overlay it on the stored bundle: breakage in files that
reference it surfaces immediately, as warnings.

## Limitations

- Completion needs at least three characters, the suggest endpoint's
  own floor.
- Parameter completion offers what your fleet's discovered models
  contain. A path no device has reported yet will not complete, which
  is by design: paths are surveyed, not invented.
- Not yet on the Marketplace; install from a release `.vsix` via
  "Extensions: Install from VSIX".

## Building

```bash
npm install
npm test        # compile + unit tests
npm run package # produces herder-vscode-<version>.vsix
```
