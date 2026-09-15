# agent-learn

从零手写 Agent —— 不用任何框架，用 TypeScript + Node 直接调 LLM API，逐层理解 Agent 的本质。

> Agent 的全部秘密其实就一句话：**LLM 在一个循环里，根据对话历史决定下一步做什么，直到任务完成。**
> 框架（LangChain、Vercel AI SDK、Coze……）只是把这个循环和周边设施封装得更方便。

## 学习路线

| 课程 | 主题 | 核心概念 | 状态 |
|---|---|---|---|
| 01 | Hello LLM | 裸调 Chat API、消息角色、流式输出（SSE） | ✅ |
| 02 | Tool Calling | 函数调用协议、模型如何「调用」你的代码 | ✅ |
| 03 | Agent Loop | while 循环 + 工具 + 自主决策，第一个真 Agent | ✅ |
| 04 | Memory | 会话历史管理、上下文窗口、摘要压缩 | ✅ |
| 05 | RAG | Embedding、向量检索、给 Agent 外挂知识库 | |
| 06 | MCP | Model Context Protocol，工具的标准化协议 | |
| 07 | Multi-Agent | 规划者/执行者、子 Agent、任务编排 | |
| 08 | Framework | 用 LangChain.js 复刻前面所学（手写 vs 框架对照） | ✅ |

## 运行方式

```bash
npm install
# 配置 API Key（DeepSeek）
cp .env.example .env   # 然后填入你的 key
npm run l1
```

## 你已有的基础如何对应

- 你在 AI 面试平台写过的 SSE 流式渲染 → 第 1 课直接复用
- Axios 请求调度引擎 → 第 2 课的工具调用本质是「模型反向来调度你的函数」
- Spring AI 的 Agent 工作流对话 → 到第 3 课你会明白那套「模板方法编排」里每个环节为什么存在
