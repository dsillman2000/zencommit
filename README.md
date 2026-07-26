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

It will:
1. Analyze your changes using the configured AI model
2. Propose conventional commit message(s) grouping related files
3. Prompt you to accept (press Enter) or provide feedback to revise
4. Stage and commit once accepted

### Options

| Flag | Description |
|------|-------------|
| `--model, -m <model>` | Override the model from config |
| `--yes, -y` | Auto-accept the first suggestion without prompting |
| `--verbose, -v` | Stream agent thoughts, tool calls, and responses |

```bash
zencommit -m "claude-sonnet-4-20250514"
zencommit -y
zencommit -v
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
