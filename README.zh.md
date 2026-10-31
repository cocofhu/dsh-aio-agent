# @cocofhu/dsh-aio-agent

[English](README.md) | 中文

在 DeepSeek Harness（DSH）里用 Cursor、Claude Code、Codex、OpenCode、CodeBuddy 或 Kimi Code 运行会话。每个 Agent 作为一个模式出现在模式菜单中，它的模型出现在原生模型菜单中。这类会话的每一轮都交给 DSH 所在机器上的 Agent CLI 执行，经由 [Agent Client Protocol](https://agentclientprotocol.com)（ACP），Cursor 和 CodeBuddy 则用 CLI 的 JSON 流模式（可报告 token 用量）；DSH 只负责展示对话和记录会话日志，不会调用自己的模型。

<a href="docs/promo.mp4"><img src="docs/promo.webp" alt="在 DSH 模式菜单中切换到 Cursor、搜索模型、实时对话、查看轨迹和 Token 用量" width="100%"></a>

[观看 1080p 视频](docs/promo.mp4)

## 安装

打开 **插件 → 添加插件**，输入 `github:cocofhu/dsh-aio-agent`，点击 **安装**，再点 **立即启用**。也可以在终端执行：

```sh
dsh plugin add github:cocofhu/dsh-aio-agent
```

用 `npm pack` 打出的发布包（`cocofhu-dsh-aio-agent-<版本>.tgz`）也可以填路径或 URL 安装。升级时先卸载再安装新版，配置保留在 profile 中。

然后在运行 DSH 的机器上安装并登录需要的 Agent：

| Agent | 安装 | 登录 |
| --- | --- | --- |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| Claude Code | `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude auth login` |
| Codex | `npm install -g @openai/codex @zed-industries/codex-acp` | `codex login` |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` | 运行 `codebuddy` 后执行 `/login`；`~/.codebuddy/models.json` 中的模型无需登录 |
| Kimi Code | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | `kimi acp --login` |

未安装或未登录的 Agent 不会出现在模型菜单里，也不会报错；它的配置页会列出上面的步骤，并提供复制按钮。

## 使用

1. 新建会话时，在模式菜单中选择 **Cursor**、**Claude Code**、**Codex**、**OpenCode**、**CodeBuddy** 或 **Kimi Code**。
2. 在模型菜单中选择该 Agent 的模型，或保留默认值。
3. 照常发送消息，回复会随 Agent 输出实时显示。停止、排队和对话记录与普通会话一致；工具调用显示为原生的终端、读取、写入和编辑步骤。

对话上下文保存在 CLI 一侧。如果 Agent 支持 `session/load`，DSH 重启后会接着原来的 CLI 会话继续。

## 配置

**插件 → AIO Agent** 中每个 Agent 是一个可单独开关的组件；关闭后，它的模式和模型都会移除。点击 **配置** 打开该 Agent 的页面：

- **状态**：显示「已就绪」及模型数量；DSH 无法启动它时，显示安装和登录步骤。**重新检测** 会重新读取状态。
- **默认模型**：会话未选择模型时使用。
- **启动命令**：替换内置命令，例如 `"/opt/Cursor Agent/cursor-agent" acp`，含空格的路径要加引号。
- **自动批准权限请求**：Agent 在执行操作前（如运行命令）发起请求时，开启则批准，关闭则拒绝。Agent 无需请求就能执行的操作，由它自身的设置决定。

保存的值写入 profile 的 `cordis.patch.yml`，从下一轮开始生效，无需重新加载。

## 会话日志

双向的每一条 ACP 消息都会以 `plugin:dsh-aio-agent/acp` 记录在会话日志中，敏感字段已脱敏。权限应答记录为 `plugin:dsh-aio-agent/permission`，DSH 会话与 CLI 会话的绑定关系记录为 `plugin:dsh-aio-agent/binding`。

## 已知限制

- 工具调用要等它执行完才出现，因为 ACP Agent 到那时才给出完整参数；文本和思考内容是实时流式显示的。
- 输入框中的访问模式不会限制外部 Agent。
- 状态无法区分「未安装」和「未登录」。
## 开发

```sh
npm test               # node --test
npm run build:logos    # 把 assets/provider-logos 重新内联进 lib/client.js
npm pack               # 打出 tarball，在「添加插件」中安装做本地试用
```

品牌图标来自 [lobe-icons](https://github.com/lobehub/lobe-icons)（MIT），详见 `assets/provider-logos/README.md`。
