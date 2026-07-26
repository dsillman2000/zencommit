# AGENTS.md — zencommit

AI-powered conventional-commit generator. Single-package Node CLI; no tests, no lint, no CI.

## Quick orientation

- **Stack**: TypeScript + Node ESM, AI SDK v4 (`@ai-sdk/openai-compatible`), `simple-git`, `commander`, `zod`.
- **Entrypoint**: `src/index.ts` (registers commander; user calls land here as `bin: zencommit` = `./dist/index.js`).
- **Orchestrator**: `src/zencommit.ts`, exports `run(opts)`. All branching lives here.
- **Public surface** (`tsconfig`): compiled to `dist/`. `src/` is git-tracked; `dist/` is gitignored.

## First-run setup

```bash
zencommit config set key "sk-opencode-…"
zencommit config set model "gpt-4o"
zencommit config validate
```

Config lives at `~/.config/zencommit/config.json` (or `$XDG_CONFIG_HOME/zencommit/config.json`). Reads are tolerant of a missing config; writes create the directory recursively.

## Commands

| Task | Command |
|---|---|
| Typecheck / build | `npm run build` (= `tsc`) |
| Dev (no compile) | `npm run dev` (= `tsx src/index.ts`) |
| Run built binary | `npm start` (= `node dist/index.js`) |

There is no `npm test` and no `npm run lint`. Do **not** invent them.

## Source map

```
src/
├── index.ts            # commander wiring, bin target
├── zencommit.ts        # run() orchestrator + readline loop + SIGINT + retries
├── config.ts           # readConfig/writeConfig at ~/.config/zencommit/
├── prompt.ts           # SYSTEM_PROMPT, status+diff pre-fetch, AGENTS.md ingest
├── repair.ts           # repairJSON, validateFileCoverage, retry feedback builders
└── tools/
    ├── index.ts        # tool registry exposed to the agent (no gitStatus)
    ├── git-tools.ts    # gitDiff (16KB cap), gitLog (max 20 entries)
    └── file-tools.ts   # readFile (50KB cap), path-traversal guarded
```

## Architectural invariants

These are load-bearing. If you change one, re-read the surrounding layer.

1. **`systemContent = SYSTEM_PROMPT + agentsMdContent`** is computed **once** and reused across the initial call, format retry, file-coverage retry, and every refocus iteration. Anything you append must be deterministic between iterations.
2. **`maxSteps: 3`** in `src/zencommit.ts` is the budget for the initial pass. Don't raise without justifying latency. Refocus iterations run with `maxSteps: 1`, `tools: {}`.
3. **`Output.object({ schema: commitSchema })`** with `.describe()` on every Zod field is the only path that produces a valid plan. Don't add a `text:` side channel; the spinner-vs-readline conflict means streaming text would interleave awkwardly.
4. **Status is pre-fetched** into the prompt (`<changed_files>`) and per-file diffs are budgeted at **4 KB/file / 32 KB total / 50 files max**. So `gitStatus` is intentionally NOT a tool. Don't re-add it — it duplicates work and burns a round-trip.
5. **File coverage is validated post-generation**: every changed file must appear in exactly one commit's `files[]`. On violation, one focused retry runs with `maxSteps: 1, tools: {}`.
6. **No-object retry path**: `NoObjectGeneratedError` → `repairJSON(err.text)` → if still bad, one focused format-retry. After that, fail-fast. Don't loop.

## CLI surface (do not silently change)

Flags: `-V --version`, `-m --model <model>`, `-y --yes`, `-v --verbose`, `-h --help`. Subcommand: `config {set,get,show,validate}`. Defaults are unchanged.

## Spinner + readline contract

- One `SpinnerHandle` (now `activeSpinner`) at a time. The original spinner is **stopped** before `renderCommits` runs so the prompt doesn't get clobbered.
- SIGINT handler closes over `activeSpinner` so Ctrl+C kills whatever iteration is in flight and exits 130.
- Refocus iterations spawn a fresh spinner just before `runReplan`. Reuse the closure pattern in `src/zencommit.ts:451-460`.
- Non-TTY stdin aborts with exit 1 *before* the model call, by design (`src/zencommit.ts:218`).

## Commit-message steering (loaded into the LLM)

`loadAgentsMd()` reads this file at `<cwd>/AGENTS.md` and appends it after `SYSTEM_PROMPT` and before any user `--prompt`. Anything you write here will bias generated commit messages. Keep it factual and consistent with this codebase:

- **Scopes**: prefer specific lowercase nouns already present in module names (`zencommit`, `tools`, `prompt`, `repair`). Avoid vague scopes (`core`, `misc`, `chore-of-chores`).
- **Type choice**: `refactor` for non-observable restructuring; `feat` for new capability; `fix` for behavior change; `chore` for tooling-only diffs. Renaming a *flag* is `feat`, not `refactor`.
- **One commit per logical concern**. Don't group unrelated files just because they touched the same day.
- **Description**: imperative mood, lowercase, no trailing period, ≤ 60 chars when practical.

## What NOT to do

- Don't add a test runner/linter/CI without a concrete need; the project is intentionally small.
- Don't change `commitSchema` field shapes without updating `validateFileCoverage` and `buildFilesRetryFeedback` in lockstep.
- Don't raise the diff budgets (`PER_FILE_BUDGET`, `TOTAL_DIFF_BUDGET`, `MAX_FILES_FOR_DIFF`) without measuring context-bloat impact on `maxSteps: 3`.
- Don't add a new top-level flag without keeping `--yes` semantics (must still skip the readline loop).
- Don't write to `dist/` by hand — let `tsc` regenerate from `src/`.
