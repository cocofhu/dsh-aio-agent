# @cocofhu/dsh-aio-agent

English | [中文](README.zh.md)

Run sessions in Cursor, Claude Code, Codex, OpenCode, CodeBuddy or Kimi Code from inside DeepSeek Harness (DSH). Each agent appears as a mode in the mode menu, and its models appear in the native model selector. Every turn of such a session runs in the agent CLI on the DSH machine. Cursor, Claude Code, Codex, OpenCode and CodeBuddy run one process per turn in their JSON stream mode (`cursor-agent --print`, `claude -p`, `codex exec --json`, `opencode run --format json`, `codebuddy --print`), which reports token usage and resumes the CLI's own session by id; Kimi Code runs over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). DSH only renders the conversation and keeps the session log; it never calls its own model for these sessions.

<a href="docs/promo.mp4"><img src="docs/promo.webp" alt="Switching to Cursor in the DSH mode menu, searching its models, a live turn, the trajectory and token usage" width="100%"></a>

## Install

Open **Plugins → Add plugin**, enter `github:cocofhu/dsh-aio-agent`, choose **Install**, then **Enable now**. From a terminal, the same install is:

```sh
dsh plugin add github:cocofhu/dsh-aio-agent
```

A release tarball (`cocofhu-dsh-aio-agent-<version>.tgz`, built with `npm pack`) installs the same way by its path or URL. To upgrade, uninstall the plugin and install the new version; settings stay in the profile.

Then install and sign in to the agents you want, on the machine that runs DSH:

| Agent | Install | Sign in |
| --- | --- | --- |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` | run `codebuddy`, then `/login`; models in `~/.codebuddy/models.json` need no sign-in |
| Kimi Code | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | `kimi acp --login` |

An agent that is not installed or not signed in stays out of the model selector instead of showing an error. Its settings page shows the steps above with copy buttons.

## Use

1. Pick **Cursor**, **Claude Code**, **Codex**, **OpenCode**, **CodeBuddy** or **Kimi Code** from the mode menu of a new session.
2. Choose one of that agent's models in the model selector, or keep its default. Where the agent offers reasoning levels (Codex, OpenCode variants, Kimi Code thinking), pick one under **Reasoning effort**; Codex lists the models and levels of its own picker (`~/.codex/models_cache.json`).
3. Send messages as usual. Replies stream in as the agent writes them. Queued messages run in order after the current turn. Send on a queue row interrupts the current CLI call and resumes the same CLI session with that message. Stop cancels the active call and its tool processes, keeping pending input queued until you send again. Tool calls show up as native shell, read, write and edit steps.

The CLI keeps its own conversation context: each turn resumes the CLI session the first turn started, also after a DSH restart.

Type `/` to run a skill from this workspace or your home directory. Skills are read from `.dsh/skills`, `.agents/skills`, `.claude/skills`, `.claude/commands`, `.cursor/skills`, `.codex/skills`, `.opencode/skills`, `.codebuddy/skills` and `.kimi/skills` (project, then the same directories under your home directory). Choosing `/skill-name` highlights the chip and opens its `SKILL.md` in the sidebar. Sending it includes the skill instructions in the prompt the CLI receives, including for an agent that does not scan that directory itself. A skill the CLI loads with its own Skill tool shows as the native expandable skill card.

`/resume` continues a CLI session that already exists on this machine. The popup lists the current workspace first, then other workspaces, with the title, time and a short id. `/resume <session-id>` binds that id directly. Later turns pass it to the CLI (`--resume`, `codex exec resume`, `opencode run --session`, or ACP `session/load` for Kimi Code). DSH keeps its own transcript; it does not copy the CLI's history. After a resume, the transcript shows a resume card, a bar above the composer stays visible with that session's title, and the sidebar title changes to it.

## Configure

**Plugins → AIO Agent** lists one switchable component per agent; switching one off removes its mode and its models. **Configure** opens the agent's page:

- **Status**: ready with its model count, or the install and sign-in steps when DSH cannot start it. **Check again** re-reads it.
- **Default model**: used until a session picks a model.
- **Launch command**: replaces the built-in executable, e.g. `"/opt/Cursor Agent/cursor-agent"` or `/opt/codex --profile work`; options after it are kept. Quote paths that contain spaces.
- **Approve permission requests**: answers the requests the agent sends before acting, such as running a command. On approves, off declines. Actions the agent takes without asking follow its own settings.

Saved values go to the profile's `cordis.patch.yml` and apply from the next turn, without a reload.

## Session log

Every line of a JSON stream is recorded in the session log as `plugin:dsh-aio-agent/stream`, and every ACP frame in both directions as `plugin:dsh-aio-agent/acp`, with secrets redacted. Permission answers are recorded as `plugin:dsh-aio-agent/permission`, and the binding between a DSH session and its CLI session as `plugin:dsh-aio-agent/binding`.

## Known limitations

- Codex and OpenCode report each reply and tool call once it is complete, so their text arrives in whole messages rather than token by token.
- A Claude Code, Codex or OpenCode session begun with an earlier version of this plugin, over ACP, continues in a new CLI session; its DSH transcript stays.
- The composer's access mode does not restrict the external agent.
- The status cannot tell an agent that is not installed from one that is not signed in.
## Develop

```sh
npm test               # node --test
npm run build:logos    # re-inline assets/provider-logos into lib/client.js
npm pack               # tarball to install through Add plugin for a local trial
```

Tests use the DSH installation on `PATH` (or `DSH_ROOT`) and exercise its real agent loop with controlled CLIs for all six backends. With OpenCode and CodeBuddy installed and `DEEPSEEK_API_KEY` set, opt in to live tests for queued turns, queue Send and Stop:

```sh
DSH_AIO_LIVE_TESTS=1 node --import ./test/dsh-runtime.mjs --test test/live-driver.test.js
```

The live tests use temporary workspaces and CLI configuration; they make billed DeepSeek API calls.

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `assets/provider-logos/README.md`.

## License

[MIT](LICENSE)
