# Provider logo sources

`npm run build:logos` inlines these files into `lib/client.js`, which marks every model in the composer model selector. A model gets the mark of its family (model ID), otherwise of its provider (provider ID), otherwise `models.svg`.

The brand marks are copied unmodified from [grasp](https://github.com/cocofhu/grasp) `web/src/assets/provider-logos`, which records the upstream of each file:

- `claude.svg`, `cursor.svg`, `opencode.svg`, `deepseek.svg`, `openrouter.svg` and `moonshot.svg` come from [Simple Icons](https://github.com/simple-icons/simple-icons) v16.
- `openai.svg` comes from the [OpenAI 2025 logo package](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip). Codex uses the same mark.
- `xai.svg` is the xAI mark from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:XAI-Logo.svg).
- `kimi.svg` is the K-only mark from the [official Kimi brand guide](https://moonshotai.github.io/Branding-Guide/).
- `qwen.svg`, `doubao.svg`, `siliconflow.svg`, `minimax.svg`, `zhipu.svg`, `zai.svg`, `gemini.svg`, `hunyuan.svg` and `qianfan.svg` come from [Lobe Icons](https://github.com/lobehub/lobe-icons) at commit `7d7d0379f18b114a4009dc5cb85a7c375284f31b`; their MIT notice is in [LICENSE.lobe-icons](LICENSE.lobe-icons).

`models.svg` is DeepSeek Harness's own Models glyph (`IconDataOutlineRegular`), the icon the composer shows in place of the model name when space is short.

`../plugin-icons/codex.svg` is `openai.svg` with its viewBox cropped to the mark, used as the Codex row icon on the Plugins page; the other agent rows export their logo from this directory as is.

The brand marks remain trademarks of their owners and are shown only to identify model brands.
