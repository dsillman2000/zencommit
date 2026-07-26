# zencommit — AGENTS.md

## Prerequisites

- Initialize `fnm` before any npm command: `eval "$(fnm env --use-on-cd)"`
- Requires a valid OpenCode Zen API key in `~/.config/zencommit/config.json`

## Commands (in order)

```bash
npm run lint        # ESLint with typescript-eslint recommended rules
npm run typecheck   # tsc --noEmit
npm run build       # tsc → outputs to dist/
npm run dev         # tsx src/index.ts (no build step)
```

No test framework is configured.

## CI pipeline

`.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main`:
1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm audit --audit-level=high`

## Architecture

- **Entrypoint**: `src/index.ts` — Commander CLI, adds `config` subcommand, runs `zencommit.ts`
- **Core**: `src/zencommit.ts` — fetches git diff, calls OpenCode Zen API via `@ai-sdk/openai-compatible`, interactive commit flow
- **Config**: `src/config.ts` — reads/writes JSON at `~/.config/zencommit/config.json`
- **Tools**: `src/tools/` — Vercel AI SDK tools (`readFile`, `gitDiff`, `gitLog`) available to the model
- **Prompt**: `src/prompt.ts` — pre-fetches diffs, builds system prompt with Conventional Commits rules
- **Repair**: `src/repair.ts` — JSON repair/retry logic for malformed model output

## Quirks

- **`.js` imports required**: TypeScript `NodeNext` module resolution means all relative imports must include `.js` extension (e.g., `from "./config.js"`, not `from "./config"`)
- **AGENTS.md is runtime data**: This file is read by the app at runtime and appended to the AI system prompt. It acts as project-specific commit conventions for the model.
- **Uses OpenCode Zen API**: The app talks to `https://opencode.ai/zen/v1` via `@ai-sdk/openai-compatible`. The `@ai-sdk/openai`, `@ai-sdk/anthropic`, and `@ai-sdk/google` packages are unused deps.
- **ESLint**: Flat config at `eslint.config.js` using `tseslint.configs.recommended`. Ignores `dist/`.
- **`npm audit` in CI**: Set to `--audit-level=high --omit=dev` — devDependencies (jest deps) are excluded from the audit. Pre-existing low/moderate vulns in `ai` SDK transitive deps don't fail the build.
- **Pre-existing CVE-2026-8769**: `@ai-sdk/provider-utils <=3.0.97` has an Uncontrolled Resource Consumption issue (CVSS 4.3 MEDIUM / GHSA low). Fix requires `@ai-sdk/provider-utils >=4.0.33`. Awaiting `ai` SDK major bump — not actionable without breaking upstream changes.
