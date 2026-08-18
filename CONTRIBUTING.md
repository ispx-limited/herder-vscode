# Contributing

Wanted: bug fixes, completion contexts the detectors miss, and
validation routing corrections. New features should stay inside the
extension's one job, editor support for Herder config repos; anything
that needs a new Herder API belongs upstream first.

Build and test:

```bash
npm install
npm test        # tsc + node:test over the pure logic in src/core.ts
npm run package # .vsix via vsce
```

Logic that can live without `vscode` imports goes in `src/core.ts` so
it stays testable; `src/extension.ts` is wiring. Commits follow
Conventional Commits (`feat:`, `fix:`); one concern per PR. Prose
follows the house style: plain words, short sentences, no em dashes,
no emoji.
