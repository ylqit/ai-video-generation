# 来源与迁移记录

本工程从参考项目选择可独立复用的模块与业务流程，重新实现持久化执行和版本契约。没有运行时链接到 reference，没有接管源项目数据库。

| 来源 | 当前快照 | 使用方式 |
|---|---|---|
| Toonflow-web | `9c4cb0ec7d4f6b4067c7768e2df8cdc7f8587214` | `src/utils/parseNovel.ts`、`parseScript.ts` 源码副本迁入 `src/shared/toonflow`；去除全局 Pinia 依赖，修正全角数字和自定义正则全局标记。项目、剧本、素材、分镜、剪辑流程参考其页面；新 UI 使用新的 API 契约 |
| Toonflow-app | `e03cf590eb0cab63534a4040db9acb4ec95b42a6` | 原文新增、章节事件、剧本代理的业务设计参考；原始数据库、动态供应商执行及 Electron 启动链未复制，新的 service 与 Worker 实现对应职责 |
| oh-my-minimaxh3-director | `911266137075a0b9fabf6268dc1c91ae05138ad9` | 导演规约改编；`wenwu-director.md`、`hybrid-example.md` 独立副本；模板改为原生 H3 编译器，不使用原脚本的提交重试 |
| catflow-studio | 当前工作区分析基线见集中分析文档 | 借鉴输入冻结、回执、候选采用、连续性、EDL 的设计；未复制限定角色的领域模型 |
| ComfyUI_JR_MiniMaxH3Node | 集中分析记录的快照 | 可选外部组件，本工程无代码复制、无运行时强依赖 |
| Open-Magiviz | 集中分析记录的快照 | 仅流程和产品交互参考 |

Toonflow 两个项目为 Apache-2.0；导演工具为 MIT。完整文本分别在 `licenses/`。保留源代码内已有声明。第三方包许可证以 package-lock.json 对应依赖为准。视频模型权重与 ComfyUI 自身许可证独立，不由本工程源码许可替代。

官方 `@openai/codex` 0.154.0 作为工程内 CLI 运行依赖锁定，许可证为 Apache-2.0；不修改全局 Codex 安装和配置。依赖安装时曾遇到官方包下载连接停滞，重试后完整安装并验证版本，`npm install` 的依赖审计返回0个已知漏洞（仅代表当次依赖审计）。

本轮迁移范围是可运行的通用创作闭环，并未复制 Toonflow 的全部页面、商业模块或既有 API。后续扩展也须通过新契约接入，不引入对 reference 目录的运行依赖。

2026-09-12 导演/空间迭代新增运行依赖 `three` 0.186.0 和开发类型依赖 `@types/three` 0.186.0。Three.js 版权为 © 2010–2026 three.js authors，MIT 文本保存在 [licenses/three-MIT.txt](licenses/three-MIT.txt)。本机预演按需加载此包，不依赖 Blender；包许可与模型许可分开。
