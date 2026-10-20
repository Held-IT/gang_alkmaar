# Gang Alkmaar

Gang Beasts-style wobbly-ragdoll brawler in the real 3D Alkmaar (copy of "Alkmaar Drive":
Three.js r186 + Rapier, Electron .exe). Read `docs/GANG_ALKMAAR.md` first (new modules,
ownership, factories, gameplay rules), then `docs/ARCHITECTURE.md` (reused engine, data formats,
coordinates) and the contracts in `src/brawl/contracts.ts` + `src/contracts.ts`.

Rules:
- Only edit files your module owns (docs/GANG_ALKMAAR.md ownership table; reused Alkmaar Drive
  modules are frozen unless your brief says otherwise). Contracts are orchestrator-owned.
- Never run `npm install` / add dependencies. `reference/` is read-only study material (never build/run it).
- No Gang Beasts / Boneloaf assets, names or logos; no real trademarks. User-facing text is Dutch.
- TypeScript strict; `npx tsc --noEmit -p .` must pass before you finish.
- Verify visually with `node tools/shot.mjs --scene <scene> --out shots/<module>/<name>.png` and
  look at the PNG. Fix all `[console.error]` output.
- Performance target: 60 fps @1080p on a GTX 1660 Super; dev machine is a weaker AMD iGPU.
