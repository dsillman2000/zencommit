# zencommit

AI-powered commit message generator using the [OpenCode Zen API](https://opencode.ai). Analyzes staged and unstaged changes in a git repo, generates conventional commits, and lets you review and revise before committing.

## Install

```bash
npm install -g zencommit
```

## Setup

zencommit requires an OpenCode Zen API key. Set your key and preferred model:

```bash
zencommit config set key "sk-opencode-..."
zencommit config set model "gpt-4o"
zencommit config validate
```

Configuration is stored at `~/.config/zencommit/config.json`.

## Usage

Run `zencommit` in a git repository with changes:

```bash
zencommit
```

### Workflow

1. **Analysis** — zencommit inspects your working tree (staged, unstaged, and untracked files) and sends diffs to the AI model
2. **Review** — a suggested commit plan is displayed with types, scopes, descriptions, and assigned files
3. **Steer with feedback** — instead of accepting, type free-form feedback to revise:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    1. feat(api): add user endpoint
       Files
         • src/api.ts
         • src/api.test.ts

    2. fix(auth): correct token expiry check
       Files
         • src/auth.ts

   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Enter to commit · Ctrl+C to abort · feedback: split auth change into its own commit
   ```

4. **Iterate** — the model revises the plan based on your feedback. Repeat as many times as needed
5. **Commit** — press Enter (empty feedback) to stage and commit

### Options

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Override the model from config |
| `-y, --yes` | Skip the review prompt and commit the first suggestion immediately |
| `-v, --verbose` | Stream agent thoughts, tool calls, and responses to stdout |
| `-p, --prompt <prompt>` | Inject a custom instruction into the user prompt, before the diff context |

```bash
zencommit -m "claude-sonnet-4-20250514"
zencommit -y
zencommit -y -m "gpt-4o"
zencommit -v
zencommit -p "Use emoji prefixes in commit messages"
zencommit -p "Group all test file changes into a single separate commit"
```

### `zencommit config`

Manage the zencommit configuration:

```bash
zencommit config set <key> <value>   # Set a config value
zencommit config get <key>            # Get a config value
zencommit config show                 # Display full configuration
zencommit config validate             # Validate API key and model availability
```

### Validation

`zencommit config validate` checks:

1. An API key is configured
2. The configured model is available in the [OpenCode Zen model list](https://opencode.ai/zen/v1/models)

## Project conventions

Place an `AGENTS.md` file in your repository root to provide your own project-specific commit conventions. zencommit appends it to the system prompt when generating messages.
