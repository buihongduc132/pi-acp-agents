---
name: setup-pi-plugin-deploy-pipelines
description: Two-build pi plugin pipelines (prod npm + dev local-replace) with pre-commit smoke gate.
---

$ARGUMENTS

---

# Setup pi Plugin Deploy Pipelines (Local Playbook — pi-acp-agents)

Stand up **two build pipelines** for THIS repo (`pi-acp-agents`) so it ships like a real npm package AND has a fast local dev loop. Add a pre-commit gate that proves the built output loads in pi without blocking. Specific to this repo — references local files/flow + remote.

## GOAL (DOD)

`pi-acp-agents` has:

1. **Prod pipeline** — `npm run build` produces `dist/` (compiled JS + d.ts + source maps). `npm publish` (or `npm pack` for dry run) yields an installable, runnable package. Anyone can `npm i @buihongduc132/pi-acp-agents` and it works WITHOUT transpiling. Fixes the current broken state (`main: ./index.ts`, stale `dist/` from May, no build script).
2. **Dev pipeline** — `npm run build:dev` (or reuse `build`) writes the SAME dist into the repo's own local extension dir, and pi loads that dir as a **local extension** (NOT git clone, NOT npm install). Re-running it is idempotent — same output overwrites cleanly.
3. **Pre-commit gate** — on every commit, the hook runs the build, then runs the smoke cmd:
   `pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js`
   The gate PASSES only if pi starts, loads the extension, prints JSON, exits 0, and does NOT hang. Anything else = block the commit.
4. **Idempotent setup** — running the setup steps twice produces the same end state. No drift, no duplicate entries, no orphaned files.
5. **Model policy** — smoke gate uses `bhd-litellm/rag-quick` (cheap, fast). Real pi runs default to `role-smart` (whatever the env's role-routed model resolves to) — NOT hardcoded in the package.

Less than all 5 = NOT done.

---

## 0. Prereqs (verify BEFORE touching anything)

- This repo is a pi plugin: `package.json` with `type: module`, TS source under `src/`, entrypoint `index.ts`. (CONFIRMED current state.)
- Node + npm installed. `tsx` available (pi loader uses it).
- `pi` binary on PATH. Verify: `pi --version`.
- Smoke model exists: `pi --list-models 2>/dev/null | grep -i 'bhd-litellm/rag-quick'` OR check `~/.pi/agent/models.json`. Missing → gate hangs.
- Default model routing works: `pi -p hi --mode json` (no `--model`) MUST resolve via `role-smart` in models.json. IF this hangs, models.json role-routing is broken — fix that FIRST.
- `git` repo (for the pre-commit hook to fire). (CONFIRMED.)
- Current broken state: `main: ./index.ts`, no `build` script, `dist/` stale (May 13/23 — pre-dates persistent-workers/session-scoping/DAG features). This playbook fixes all of that.

**MUST** verify all of the above. Missing `pi`, wrong model, or the stray committed/stale `dist/` will silently break the gate.

---

## 1. Prod pipeline — build → dist → publish

### 1.1 Bundler: tsup

tsup (esbuild under the hood) is the DEFAULT for pi plugins. Fast, zero-config, d.ts via follow-up tsc. AVOID webpack/rollup — overkill, slow, breaks ESM/CJS interop.

### 1.2 Fix `package.json`

Current broken state to FIX:
```jsonc
// BROKEN (current):
"main": "./index.ts",
"types": "./src/public-api.ts",
"files": ["index.ts", "src/**/*.ts", ...],
// no "build" script
```

Target state:
```jsonc
{
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist", "skills/**/*", "README.md", "CHANGELOG.md", "LICENSE"],
  "scripts": {
    "build": "tsup",
    "build:types": "tsc --emitDeclarationOnly --outDir dist",
    "build:dev": "tsup",                          // alias — same output, local consume
    "prepublishOnly": "npm run build && npm run build:types && npm run test:ci",
    "prepack": "node scripts/prepack.mjs",
    "postpack": "node scripts/postpack.mjs"
    // keep existing: test, typecheck, release:*, publish:*
  }
}
```

- `main`/`module`/`types` MUST point at `dist/` — NOT `index.ts`. The current `./index.ts` forces every consumer to transpile. That is the broken state this playbook fixes.
- `files` whitelist MUST include `dist`. REMOVE raw `src/**/*.ts` + `index.ts` from `files` — npm tarball ships compiled only.
- `pi-acp-agents` has NO `bin` (it's a library/extension, not a CLI) — DO NOT add one. If a CLI gets added later, wire `bin` then.
- `prepublishOnly` runs build + types + tests before publish — this is the prod gate.

### 1.3 Add `tsup.config.ts`

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],              // matches package.json "type": "module"
  dts: true,                    // or false + separate build:types
  sourcemap: true,
  clean: true,                  // wipe dist before each build (idempotent)
  target: 'node20',
  platform: 'node',
  shims: true,
});
```

- `clean: true` = idempotent builds. No stale files survive a rebuild. This ALSO cleans the May-era stale `dist/` on first run.
- `format: ['esm']` MUST match `"type": "module"` in package.json. Mismatch = runtime import errors.
- IF pi-acp-agents grows top-level await or ESM-only Node APIs → keep `esm` only.

### 1.4 Build + verify locally

```bash
npm install tsup --save-dev           # IF not present
npm run build
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"   // exports resolve
ls -la dist/                                                                 // index.js + index.d.ts present
```

- IF import fails or exports empty → bundler config wrong, or entry has only side-effects no exports. Fix BEFORE publish.
- Verify the public ACP tool surface (`acp_prompt`, `acp_status`, etc.) is exported — `src/public-api.ts` is the contract.

### 1.5 Dry-run publish

```bash
npm pack --dry-run    // lists EXACTLY what ships
npm publish --dry-run --access public
```

- `npm pack --dry-run` shows tarball contents. MUST contain `dist/`, `package.json`, `README.md`, `skills/`. MUST NOT contain `src/`, `tests/`, `node_modules/`, `.git/`.
- Verify `main` path resolves inside the tarball.

### 1.6 Real publish (when ready)

```bash
npm version patch -m 'release: v%s'   // or minor/major — repo is at 0.3.1
npm publish --access public
// OR beta: npm publish --tag beta --access public
```

- Tag gate: `latest` = stable, `beta`/`next` = pre-release. NEVER publish untested to `latest`.
- `npm version` triggers the `version` script (`scripts/version-sync.mjs`) + git tag. Push tags: `git push --follow-tags`.
- Current prod-published version is 0.2.2 (per `~/.pi/agent/git/.../pi-acp-agents/package.json`); repo is 0.3.1 with 3 unshipped features (persistent-workers, session-scoping, DAG delegation). Next publish should be `minor` (0.3.1 → 0.4.0 OR just publish 0.3.1 if not yet on npm).

---

## 2. Dev pipeline — build → replace local extension

The dev pipeline runs the SAME build as prod, but the output is consumed by pi as a **local extension**, not via npm/git-clone.

### 2.1 Local extension dir: in-repo `dist/` (DEFAULT for this repo)

pi-acp-agents uses `dist/` directly. pi loads `./dist/index.js` via `-e ./dist/index.js` or a `settings.json` local path. No copy step, no `.pi-local-ext/` — keeps it simple, one source of truth.

AVOID adding `.pi-local-ext/` — drift between it and `dist/` will bite you.

### 2.2 Wire pi to load the local extension

For the smoke gate (per-invocation, isolated):
```bash
pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js
```

For persistent dev (load on every pi run): add to `~/.pi/agent/settings.json` extensions array. AVOID mixing — if `settings.json` carries it, the smoke gate can drop `-e`. Pick ONE source of truth for the persistent path; the gate ALWAYS uses `-e` (isolated test).

### 2.3 Build → replace (idempotent)

```bash
npm run build      // tsup clean:true wipes dist first → no manual rm needed
```

- `tsup clean: true` makes the build itself idempotent. No stale files.
- Local extension dir MUST mirror `files` in package.json: `dist/` + `skills/` + README/LICENSE. Anything extra = drift.

### 2.4 Reload pi

pi hot-reloads extensions on session start. For mid-session: restart pi OR re-run the smoke cmd with `-e`.

---

## 3. Pre-commit gate — build + smoke

Runs on EVERY commit. Proves: the build works, the output loads in pi, pi exits clean, pi does NOT hang.

### 3.1 The smoke cmd (CANONICAL — verify on every apply)

```bash
pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js
```

- `pi -p hi` — one-shot prompt mode, "hi" = minimal input.
- `--model bhd-litellm/rag-quick` — FAST CHEAP model for the gate ONLY. Does NOT change what model the package uses at runtime — runtime defaults to env config (`role-smart` routing in `~/.pi/agent/models.json`). Smoke = load + exit test, not intelligence test.
- `--mode json` — JSON output, no TUI, no spinner, deterministic exit.
- `-e ./dist/index.js` — load ONLY this extension. Isolates the test: if pi hangs, this extension is the cause.

**Verify the cmd matches this exact form every time you apply the playbook.** The cmd drifts when pi changes flags or the smoke model rotates. Always re-confirm against `pi --help` + `pi --list-models`.

### 3.2 Expected pass signals

- Exit code 0.
- JSON printed to stdout (the response object).
- Process exits within ~30-60s (rag-quick latency).
- NO stderr crash trace mentioning the extension.
- NO hang past the timeout.

### 3.3 Install the pre-commit hook

`.git/hooks/pre-commit` (executable, `#!/usr/bin/env bash`):

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[pre-commit] building pi-acp-agents..."
npm run build

echo "[pre-commit] smoke: pi loads the built extension..."
timeout 90 pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js >/dev/null
# timeout kills pi if it hangs → non-zero exit → commit blocked

echo "[pre-commit] OK"
```

- `set -euo pipefail` — any failure aborts the commit.
- `timeout 90` — hard ceiling. rag-quick smoke normally <60s. 90s margin. Bump to 120s if model latency spikes.
- `npm run build` MUST run BEFORE the smoke — testing stale dist = no test at all.
- AVOID `--no-verify` to skip — defeats the gate. Fix the gate instead.

### 3.4 Idempotent hook install (re-runnable)

```bash
HOOK=.git/hooks/pre-commit
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "[pre-commit] building pi-acp-agents..."
npm run build
echo "[pre-commit] smoke: pi loads the built extension..."
timeout 90 pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js >/dev/null
echo "[pre-commit] OK"
EOF
chmod +x "$HOOK"
```

- Running this twice = same hook content. Idempotent.
- IF a husky/lefthook/pre-commit framework gets added later — adapt: put the same body in their hook config. Do NOT install both raw `.git/hooks` AND a framework hook — double-fire.

### 3.5 Apply checklist for this repo

1. `package.json` — `main`/`module`/`types` point at `dist/`. `files` includes `dist`. `build` + `build:dev` scripts wired to tsup. NO `bin` (library/extension).
2. `tsup.config.ts` — present, `clean: true`, `format: ['esm']`.
3. `.gitignore` — `dist/`, `*.tsbuildinfo`, `node_modules/`. (Check current state — `dist/` may already be ignored.)
4. Pre-commit hook installed + executable.
5. `npm run build` succeeds AND wipes the May-era stale `dist/`.
6. Smoke cmd exits 0 within timeout.
7. Document the local extension path in `AGENTS.md` or `README.md` so the next agent knows where pi loads it from.

ALL 7 must hold. Any miss = pipeline broken.

---

## 4. Verify current state (run after setup AND periodically)

```bash
// 1. Build is clean
npm run build && [ -f dist/index.js ] && echo OK || echo FAIL

// 2. Smoke cmd matches canonical form + passes
timeout 90 pi -p hi --model bhd-litellm/rag-quick --mode json -e ./dist/index.js >/dev/null && echo OK || echo FAIL

// 3. Hook installed + executable
[ -x .git/hooks/pre-commit ] && grep -q 'pi -p hi' .git/hooks/pre-commit && echo OK || echo FAIL

// 4. package.json main points at dist
grep -E '"main":\s*"\./dist' package.json && echo OK || echo FAIL

// 5. npm pack ships dist, not src
npm pack --dry-run 2>&1 | grep -E 'dist/index\.js' && ! npm pack --dry-run 2>&1 | grep -E 'src/.*\.ts' && echo OK || echo FAIL

// 6. Runtime model NOT hardcoded — defaults via role-smart
grep -rE 'bhd-litellm/rag-quick' src/ && echo "FAIL: hardcoded smoke model in src" || echo OK
```

All six = OK → pipeline healthy. Any FAIL → fix before committing.

---

## DO / DON'T

- **DO** ship `main`/`module`/`types` pointing at `dist/`. Compiled JS is the contract.
- **DO** set `tsup clean: true` for idempotent builds.
- **DO** run `npm pack --dry-run` before every publish — catches `files` whitelist drift.
- **DO** gate every commit with build + pi smoke. The smoke is the only thing that proves "it loads."
- **DO** verify `bhd-litellm/rag-quick` exists in the env before relying on the gate.
- **DO** keep ONE source of truth for the local extension path (`settings.json` OR `-e` flag, not both).
- **DO** keep runtime model selection in `models.json` role-routing (`role-smart`). Smoke model ≠ runtime model.
- **DON'T** leave `main: ./index.ts` in the published package — forces every consumer to transpile. (This is the current broken state.)
- **DON'T** commit `dist/` to git. Gitignore it. (Current `dist/` is untracked-or-stale — verify + gitignore.)
- **DON'T** use webpack/rollup — tsup/esbuild/tsc only.
- **DON'T** skip the build step in the pre-commit hook — testing stale dist tests nothing.
- **DON'T** use `--no-verify` to bypass the gate. Fix the gate.
- **DON'T** install both a raw `.git/hooks/pre-commit` AND a husky/lefthook hook — double-fire.
- **DON'T** trust "build succeeded" alone — the smoke cmd is the real test. Build can succeed and the extension can still hang pi at load.
- **DON'T** hardcode `bhd-litellm/rag-quick` (or any model) in `src/` — that's the smoke-only model. Runtime MUST resolve via `models.json`.

---

## Tips / tricks

- `tsup --watch` for dev rebuilds on file change — pair with the smoke cmd in another terminal.
- `node --trace-warnings dist/index.js` to surface hidden ESM/CJS issues.
- Pin `engines.node` in package.json to match tsup `target` — prevents runtime/Node mismatches.
- pi-acp-agents ships `skills/` (ACP skill files) — include in `files` AND in the local extension copy.
- IF the extension depends on other pi plugins at runtime — declare as `peerDependencies`, NOT `dependencies`. pi loads plugins itself.
- Smoke model choice: pick the FASTEST model in the env, not the smartest. The smoke only tests load + exit, not intelligence. `bhd-litellm/rag-quick` fits.
- Runtime model: leave unset → pi resolves via `role-smart` in models.json. DO NOT pin in code.
- Set `PI_LOG_LEVEL=error` in the smoke cmd env to suppress noisy logs (cleaner JSON parse).
- The 3 unshipped features (persistent-workers, session-scoping, DAG delegation) need a fresh build + publish to land in `~/.pi/agent/git/.../pi-acp-agents/` — currently prod is at `dbb5d8c` (2026-06-18), predating all three.

---

## Lesson learned (common breakage)

- **`main: ./index.ts` shipped → consumers crash on import.** TS source in `main` is the #1 pi plugin packaging bug. CURRENT STATE of this repo — fix it.
- **`tsup` format mismatch with `type: module`** → `require is not defined` / `import` outside module. Match them.
- **Smoke cmd hangs** → extension blocks at load (sync heavy work, top-level await on missing service, infinite loop in init). Fix the extension; the gate did its job.
- **`dist/` committed + later regenerated** → git diff noise, merge conflicts. Gitignore from day one. (Verify current `dist/` state — May-era files are stale.)
- **Model in smoke cmd rotated/removed** → gate silently fails everywhere. Verify `bhd-litellm/rag-quick` exists on every apply.
- **`prepublishOnly` skipped** → untested build ships to npm. Always wire it.
- **Two local extension paths** (`dist/` AND `.pi-local-ext/`) → drift, one stale. Pick one. This playbook: `dist/`.
- **Pre-commit hook + husky both installed** → gate fires twice, commit slow, hooks diverge. One hook system only.
- **Hardcoding smoke model in `src/`** → package breaks in envs without that model. Runtime resolves via `models.json`; smoke model is gate-only.
- **Prod git-clone copy (`~/.pi/agent/git/.../`) NOT rebuilt after features ship to main** → main session runs stale code. This is the CURRENT state (0.2.2 prod vs 0.3.1 repo). Fix: run cli-agents-deploy skill to promote the rebuilt package.
- **`~/.pi/agent/AGENTS.md` + `flow/lesson_learn/2026-06-02_deploy-pipeline-rot.md`** — read before touching deploy scripts in this repo's parent (pi-plugins).

---

## Useful refs

- Local: `package.json` (current broken `main`), `tsup.config.ts` (to add), `scripts/prepack.mjs`, `scripts/version-sync.mjs`, `src/public-api.ts` (export contract), `AGENTS.md` (ACP tool manifest pointer)
- Local: `flow/plans/manifest/state.md` (ACP tool state — implemented/partial/stub)
- Local: `~/.pi/agent/AGENTS.md` (deploy pipeline rules, anti-cheat gates, post-deploy config gate)
- Local: `~/.pi/agent/AGENTS.md` → `flow/lesson_learn/2026-06-02_deploy-pipeline-rot.md` (deploy script rot post-mortem)
- Remote: tsup — https://tsup.egoist.dev/ · https://github.com/egoist/tsup
- Remote: esbuild — https://esbuild.github.io/
- Remote: npm `files` + `bin` + `main` — https://docs.npmjs.com/cli/v10/configuring-npm/package-json
- Remote: npm publish dry-run — https://docs.npmjs.com/cli/v10/commands/npm-publish
- pi CLI flags: `pi --help` (run locally; flags drift across versions)
- pi extension loading: `@earendil-works/pi-coding-agent` README on npm
