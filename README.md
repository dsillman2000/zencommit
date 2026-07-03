# zencommit

AI-powered commit message generator using the [OpenCode Zen API](https://opencode.ai).

## Setup

zencommit requires an OpenCode Zen API key. Set your key and preferred model:

```bash
zencommit config set key "sk-opencode-..."
zencommit config set model "gpt-4o"
zencommit config validate
```

## Commands

### `zencommit config`

Manage the zencommit configuration stored at `~/.config/zencommit/config.json`.

```bash
zencommit config set <key> <value>   # Set a config value
zencommit config get <key>            # Get a config value
zencommit config show                 # Display full configuration
zencommit config validate             # Validate API key and model availability
```

#### Validation

`zencommit config validate` checks:

1. An API key is configured
2. The configured model is available in the [OpenCode Zen model list](https://opencode.ai/zen/v1/models)
