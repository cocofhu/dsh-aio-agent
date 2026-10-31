# @cocofhu/dsh-aio-agent

English | [中文](README.zh.md)

Run sessions in Cursor, Claude Code, Codex, OpenCode, CodeBuddy or Kimi Code from inside DeepSeek Harness (DSH). Each agent appears as a mode in the mode menu, and its models appear in the native model selector. Every turn of such a session runs in the agent CLI on the DSH machine, over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) or, for Cursor and CodeBuddy, the CLI's JSON stream mode, which reports token usage. DSH only renders the conversation and keeps the session log; it never calls its own model for these sessions.

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
| Claude Code | `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude auth login` |
| Codex | `npm install -g @openai/codex @zed-industries/codex-acp` | `codex login` |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` | run `codebuddy`, then `/login`; models in `~/.codebuddy/models.json` need no sign-in |
| Kimi Code | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | `kimi acp --login` |

An agent that is not installed or not signed in stays out of the model selector instead of showing an error. Its settings page shows the steps above with copy buttons.

## Use

1. Pick **Cursor**, **Claude Code**, **Codex**, **OpenCode**, **CodeBuddy** or **Kimi Code** from the mode menu of a new session.
2. Choose one of that agent's models in the model selector, or keep its default.
3. Send messages as usual. Replies stream in as the agent writes them. Stop, queueing and the transcript work as in any session; tool calls show up as native shell, read, write and edit steps.

The CLI keeps its own conversation context. DSH resumes it after a restart when the agent supports `session/load`.

## Configure

**Plugins → AIO Agent** lists one switchable component per agent; switching one off removes its mode and its models. **Configure** opens the agent's page:

- **Status**: ready with its model count, or the install and sign-in steps when DSH cannot start it. **Check again** re-reads it.
- **Default model**: used until a session picks a model.
- **Launch command**: replaces the built-in command, e.g. `"/opt/Cursor Agent/cursor-agent" acp`. Quote paths that contain spaces.
- **Approve permission requests**: answers the requests the agent sends before acting, such as running a command. On approves, off declines. Actions the agent takes without asking follow its own settings.

Saved values go to the profile's `cordis.patch.yml` and apply from the next turn, without a reload.

## Session log

Every ACP frame in both directions is recorded in the session log as `plugin:dsh-aio-agent/acp`, with secrets redacted. Permission answers are recorded as `plugin:dsh-aio-agent/permission`, and the binding between a DSH session and its CLI session as `plugin:dsh-aio-agent/binding`.

## Known limitations

- A tool call shows up once it has finished, because ACP agents send its final arguments only then; text and reasoning stream as they arrive.
- The composer's access mode does not restrict the external agent.
- The status cannot tell an agent that is not installed from one that is not signed in.
- Mode names and descriptions in the mode menu are English only.

## Develop

```sh
npm test               # node --test
npm run build:logos    # re-inline assets/provider-logos into lib/client.js
npm pack               # tarball to install through Add plugin for a local trial
```

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `assets/provider-logos/README.md`.
