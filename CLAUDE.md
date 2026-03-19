# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/_templates/main/CLAUDE.md` | Template for main group CLAUDE.md (tracked in git) |
| `groups/_templates/global/CLAUDE.md` | Template for global CLAUDE.md (tracked in git) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated, gitignored) |
| `container/tool-docs/*.md` | CLI tool documentation snippets, injected per-group based on `containerConfig` flags |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Group Templates

Operational group folders (`groups/main/`, `groups/global/`, etc.) are gitignored — they contain per-installation state and memory. Tracked templates live in `groups/_templates/`:

- `groups/_templates/main/CLAUDE.md` — template for the main (admin) group
- `groups/_templates/global/CLAUDE.md` — template for global shared context (injected into all non-main groups)

Templates use `{{PLACEHOLDER}}` syntax for instance-specific values:

| Placeholder | Replace with |
|-------------|-------------|
| `{{ASSISTANT_NAME}}` | The bot's name (e.g., `Claw`) |
| `{{CHANNEL_NAME}}` | Primary channel (e.g., `Microsoft Teams`, `WhatsApp`) |
| `{{CHANNEL_PREFIX}}` | JID prefix (e.g., `teams`, `whatsapp`, `telegram`) |
| `{{GROUP_FOLDER}}` | The main group's folder name |

On fresh deploy, copy templates to operational paths and fill in placeholders. The `/setup` skill handles this automatically.

## Adding CLI Tools to Containers

Container agents can access external CLI tools (GitHub CLI, Azure CLI, Atlassian API, etc.) gated by per-group `containerConfig` flags. Tool documentation is automatically injected into the agent's system prompt when the flag is enabled — no manual CLAUDE.md maintenance needed.

### How it works

1. **Snippets** in `container/tool-docs/*.md` — one file per tool with usage examples
2. **Host-side** (`src/container-runner.ts`): `writeToolDocsSnapshot()` reads the group's `containerConfig`, assembles matching snippets into `tool-docs.md` in the group's IPC directory
3. **Container-side** (`container/agent-runner/src/index.ts`): reads `/workspace/ipc/tool-docs.md` and appends it to the system prompt
4. **Call sites**: `src/index.ts`, `src/task-scheduler.ts`, `src/alert-processor.ts` all call `writeToolDocsSnapshot()` before container launch

### Adding a new tool

1. **Install the tool in the container** — add install steps to `container/Dockerfile`
2. **Create a doc snippet** — add `container/tool-docs/<toolname>.md` with a heading and usage examples
3. **Add the config flag** — add `<toolname>Access?: boolean` to `ContainerConfig` in `src/types.ts`
4. **Map flag to snippet** — add `<toolname>Access: '<toolname>.md'` to `TOOL_DOC_FILES` in `src/container-runner.ts`
5. **Inject credentials** — in `container-runner.ts` `buildContainerArgs()`, add env vars when the flag is set (follow the pattern of `githubToken`/`atlassianCreds`/`azureCreds`)
6. **Authenticate in entrypoint** — if the tool needs login at startup, add a conditional block in the `ENTRY` heredoc in `container/Dockerfile`
7. **Rebuild** — `./container/build.sh` and delete stale `data/sessions/*/agent-runner-src/` dirs

Enable for a group by setting the flag in its `containerConfig` (via `register_group` MCP tool or direct DB update). The agent will automatically receive the tool's documentation on its next invocation.

### Existing tools

| Flag | Snippet | Credentials |
|------|---------|-------------|
| `githubAccess` | `github.md` | `GH_TOKEN` from `~/.config/nanoclaw/github-tokens.json` |
| `azureAccess` | `azure.md` | Service principal env vars from `.env` |
| `atlassianAccess` | `atlassian.md` | Bearer token + site from `~/.config/nanoclaw/atlassian-tokens.json` |

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && git merge whatsapp/main && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
