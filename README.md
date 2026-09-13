# oi-pi · 信奥助教

终端里的 C++ 信息学竞赛教练（CSP-J/S、NOIP 方向）：一个自研 TUI 上的 AI agent，
自带 OJ 式判题器，按「提问式教学」的守则带练——不给答案，把学生往答案的方向引。

<!-- 界面截图：把图片放到 docs/screenshots/ 后取消注释
![主界面](docs/screenshots/hero.png)
![判题卡片](docs/screenshots/judge-card.png)
-->

## 它长什么样

- **Catppuccin Mocha 配色**：user/assistant 消息左侧角色色条，ASCII 字标开机画面
- **判题卡片**：judge 跑完后逐测试点显示 verdict/耗时/差异；全 AC 折叠成一行，有 WA/TLE/RE 才展开
- **常驻状态栏**：当前模型 · 上下文占用（ctx%，超 75% 变黄 90% 变红）· 会话累计 token/费用 · 生成中 spinner + 耗时
- **补全与选择器**：输入 `/` 补全命令；`/model`、`/resume` 方向键选择，不用背序号

## 教学守则（内置提示词的核心）

- 学生问「怎么做」：先反问已试过什么，给方向不给实现；提示力度三档逐级升级
- 学生问「哪里错了」：先让他把输入/期望/实际说清楚，建议自己加调试输出
- 只有学生明说「在比赛/考试里，很急」才解锁完整代码

守则在 `prompts/system.md`，可直接改。知识点清单在 `prompts/knowledge.md`
（条目参考 CCF《全国青少年信息学奥林匹克系列竞赛大纲（2025 年修订版）》整理，仅作个人学习记录，非商业用途），
学生做完题、确认掌握后，agent 会自动勾选并标注掌握等级。

## 内置工具

| 工具 | 作用 |
| --- | --- |
| `judge` | 编译并判题：C++（g++）/ Python（python3），多测试点 AC/WA/TLE/RE/CE、时限与内存限制、Special Judge（答案不唯一的题） |
| `stress` | 对拍/压力测试：随机数据下比对暴力解与优化解的输出 |
| `complexity` | 复杂度估算：实测运行时间随规模的增长趋势 |
| `hint` | 维护知识点掌握清单（勾选/取消/标注等级备注） |
| `read` `write` `edit` `ls` `delete_file` | 文件读写改删与列目录，只允许工作目录（`OI_PI_WORKSPACE`，默认进程 cwd）与 `/tmp`；删除前会在界面弹确认 |

## 安装

前置：Node.js ≥ 20、pnpm（或 npm）、g++（判 C++ 题）；要判 Python 题再装 python3。

```bash
git clone <本仓库>
cd oi-pi
pnpm install
```

配置模型目录 `~/.oi-pi/agent/models.json`（OpenAI 兼容接口即可，`apiKey` 直接写在 provider 里）：

```json
{
  "providers": {
    "my-provider": {
      "name": "My Provider",
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "model-id",
          "name": "Model Name",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0.03, "output": 0.15, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 131072,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

默认使用 `OI_PI_MODEL` 指定的模型（格式 `provider/modelId`，默认 `agnes/agnes-2.5-flash`）；
也可以在项目根放 `.env` 写环境变量，或用 `OI_PI_AGENT_DIR` 把整个配置目录换到别处。
其他环境变量：`OI_PI_THINKING`（思维链深度，默认 `off`）、`OI_PI_WORKSPACE`（文件工具允许根目录，默认进程 cwd）、`OI_PI_AUTOCOMPACT`（上下文自动压缩阈值，默认 `0.85`，设 `0` 关闭）。

## 运行

```bash
pnpm start          # 开发运行（tsx，免编译）
pnpm compile        # 编译到 dist/（node dist/tui.js 可直接跑产物）
pnpm build          # 编译并打包成 npm 包（oi-pi-<版本>.tgz）
```

打包产物可全局安装为 `oi-pi` 命令（`files` 只带 dist 与 prompts，装完即用）：

```bash
npm install -g ./oi-pi-1.0.0.tgz   # 发布到 npm 后即 npm install -g oi-pi
oi-pi                               # 在任意目录启动，工作目录即当前目录
```

冒烟脚本：

```bash
pnpm smoke          # 全链路冒烟（需要可用模型 API）
pnpm smoke:ui       # TUI 组件渲染冒烟（不需要 API）
pnpm smoke:judge    # judge 工具冒烟（本地编译运行，不需要 API）
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/new` | 新对话（自动保存当前对话，提示词改动此时生效） |
| `/resume` | 打开历史会话选择器，恢复后判题卡片原样重渲染 |
| `/retry` | 重试上一轮失败的提问（限流/超时类错误自动退避重试 ≤2 次） |
| `/rewind` | 回退到历史任意提问：原样重跑或撤掉重新输入 |
| `/status` | 查看模型/上下文占用/累计用量/工具清单/会话信息 |
| `/compact` | 把对话历史压缩成摘要 + 最近几条（上下文吃紧时用；超过阈值也会自动压缩，`OI_PI_AUTOCOMPACT=0` 关闭） |
| `/fork` | 从当前对话分叉出新会话（原会话停在分叉点） |
| `/del` | 删除历史会话（界面确认后才删） |
| `/export` | 导出当前对话为 Markdown（落在工作目录） |
| `/model` | 打开模型选择器；`/model <provider/id>` 直接切换 |
| `/thinking [级]` | 查看/切换思维链深度；生成中实时流出、回答结束自动收起为「💭 已思考 Xs」 |
| `/exit` | 退出 |
| `/help` | 帮助 |

Ctrl+C / Esc：生成中中断，空闲时 Ctrl+C 退出。**生成中继续打字不会丢**——自动排队，本轮回答结束后发送。
启动时带参数可直接开问：`oi-pi "合并果子怎么入手？"`。
会话自动保存在 `~/.oi-pi/agent/sessions/`。

### MCP 接入

编辑 `~/.oi-pi/agent/mcp.json` 接入任意 stdio MCP 服务器，工具在启动时自动挂载（命名 `服务器_工具`）：

```json
{
  "servers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

## License

[MIT](LICENSE)
