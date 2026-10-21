/**
 * 第 5 课：RAG —— 给 Agent 外挂一个知识库
 *
 * 前四课的 Agent 再聪明，也不知道**你的**东西：你的笔记、你的文档、你的业务规则。
 * 模型的知识冻结在训练那一刻，而且它压根没见过你的私有资料。
 *
 * RAG（Retrieval-Augmented Generation）的思路朴素得不像个"技术"：
 *
 *   先去你的资料里**检索**出相关的几段，再把它们**塞进 prompt**，然后照常问模型。
 *
 * 就这么简单。真正的工程量全在"检索得准不准"上 —— 所以本课拆成两个文件：
 *
 *   explore.ts  只看检索层（切块 / 向量 / 余弦 / top-k），不接模型
 *   index.ts    本文件，把检索接上模型，并且演示**两种接法**
 *
 * ── 两种接法：这是本课真正的分水岭 ──
 *
 *   【Demo A 朴素 RAG】固定检索一次 → 塞进 prompt → 问一次 → 结束
 *     优点：快、便宜、可预测（一次检索 + 一次生成，没有第二轮）
 *     缺点：检索什么由**你**写死在代码里。问题复杂一点，一次检索就不够用
 *
 *   【Demo B Agentic RAG】把"检索"注册成一个**工具**，交给第 3 课的循环
 *     模型自己决定：要不要检索、检索什么、检索几次、够不够、要不要再查一遍
 *     代价：多轮 LLM 调用，更慢更贵，而且行为不那么可预测
 *
 * 大部分人只见过 Demo A，就以为 RAG 就是"向量库 + prompt 模板"。
 * Demo B 才是 Agent 时代 RAG 的常态 —— 而它需要的全部基础设施，你第 3 课就写完了。
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（工具变 async 了）第 3 课的 Tool.execute 是**同步**的 (args) => string。
 *      可检索要发网络请求（先嵌入 query），同步签名在这里第一次不够用。
 *      所以本课的 execute 返回 Promise<string>，executeTool 也跟着变 async。
 *      记住这个缝 —— 第 6 课 MCP 会撞上同一堵墙，所有框架最后都收敛到 async 工具接口。
 *
 *   ★ 2（必须有"不知道"的出口）top-k 检索**永远会返回 k 条**，哪怕语料里压根没有
 *      相关内容。这时如果你不设门槛、把 3 条不相干的硬塞给模型，它就会一本正经地编。
 *      本课在 prompt 里明确要求"资料不足就说没提到"，并且把分数一起给模型看。
 *
 *   ★ 3（溯源）把来源（文件名 + 标题）跟着正文一起塞进去，答案才能标注出处。
 *      这是 RAG 相对"纯靠模型记忆"的**唯一**硬优势 —— 不标来源，就等于放弃它。
 *
 *   ★ 4（embedding 是另一家厂商）DeepSeek 没有 embedding 接口，本课用硅基流动的
 *      BAAI/bge-m3。另一套 key、另一个 base_url（注意它带 /v1，DeepSeek 不带）。
 *
 * 工具的写法仍然跟第 3、4 课保持一致：zod 单一数据源。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(HERE, 'docs')
const CACHE_FILE = path.join(HERE, '.cache', 'embeddings.json')

// 对话模型：还是 DeepSeek（跟第 1~4 课一样）
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

// 嵌入模型：换成硅基流动。★ 注意 base_url 带 /v1，和上面的 DeepSeek 不一样
const EMB_BASE_URL = process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1'
const EMB_API_KEY = process.env.SILICONFLOW_API_KEY
const EMB_MODEL = process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3'

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type AssistantMessage = Omit<Message, 'role'> & { role: 'assistant' }

// ---------- 语料与切块（和 explore.ts 同一套，这里为了文件自包含又抄了一遍） ----------

const CHUNK_SIZE = 300
const CHUNK_OVERLAP = 60
const MIN_CHUNK_SIZE = 40 // 比这更短的块直接丢掉（退化块只会稀释检索结果）

interface Chunk {
  source: string
  title: string
  text: string
}

// ★ 丢掉正文开始之前的内容（「来源 / 版权」这类元信息）。
//   元信息块对**任何** query 都有一个不高不低的相似度，是检索里的纯噪音，
//   经常挤掉真正相关的片段。explore.ts 里能看到过滤前后的差别。
function stripFrontMatter(text: string): string {
  const firstHeading = text.search(/^#\s/m)
  return firstHeading >= 0 ? text.slice(firstHeading) : text
}

function chunkDoc(source: string, raw: string): Chunk[] {
  const text = stripFrontMatter(raw)
  const sections: { title: string; body: string[] }[] = []
  let title = source
  let body: string[] = []

  for (const line of text.split('\n')) {
    // 一级标题也当标题用（它是文章标题，正好给开头那段当 title）。
    // 只认 ## 和 ### 的话，`# Module 的语法` 那行会被当成正文，
    // 自己变成一个只有标题没有内容的"退化块"，跟什么 query 都像，老是冒到前面占位。
    const heading = /^#{1,3}\s+(.*)$/.exec(line)
    if (heading) {
      if (body.length) sections.push({ title, body })
      title = heading[1].trim()
      body = []
    } else {
      body.push(line)
    }
  }
  if (body.length) sections.push({ title, body })

  const chunks: Chunk[] = []
  for (const section of sections) {
    const content = section.body.join('\n').trim()
    if (content.length < MIN_CHUNK_SIZE) continue
    if (content.length <= CHUNK_SIZE) {
      chunks.push({ source, title: section.title, text: content })
      continue
    }
    const step = CHUNK_SIZE - CHUNK_OVERLAP
    for (let i = 0; i < content.length; i += step) {
      chunks.push({ source, title: section.title, text: content.slice(i, i + CHUNK_SIZE) })
    }
  }
  return chunks
}

function loadChunks(): Chunk[] {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => chunkDoc(f, fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')))
}

// ---------- 向量化（带磁盘缓存，跟 explore.ts 同一个缓存文件，互相复用） ----------

async function embedRaw(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${EMB_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMB_API_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
  })
  if (!res.ok) throw new Error(`嵌入 API 错误 ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { data: { embedding: number[] }[] }).data.map((d) => d.embedding)
}

type Cache = Record<string, number[]>

function loadCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache
  } catch {
    return {}
  }
}

function cacheKey(text: string): string {
  return `${EMB_MODEL}:${crypto.createHash('sha1').update(text).digest('hex')}`
}

// 批次大小：一次请求带多条文本，建索引时能少发很多请求
const BATCH_SIZE = 16

async function embedAll(texts: string[]): Promise<number[][]> {
  const cache = loadCache()
  const vectors: (number[] | null)[] = texts.map((t) => cache[cacheKey(t)] ?? null)

  const missing: number[] = []
  for (let i = 0; i < texts.length; i++) if (!vectors[i]) missing.push(i)

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const idx = missing.slice(i, i + BATCH_SIZE)
    const fresh = await embedRaw(idx.map((j) => texts[j]))
    idx.forEach((j, k) => {
      cache[cacheKey(texts[j])] = fresh[k]
      vectors[j] = fresh[k]
    })
  }

  if (missing.length) {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
  }
  return vectors as number[][]
}

// ---------- 余弦相似度（显式范数，不假设服务端归一化） ----------

function norm(v: number[]): number {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (norm(a) * norm(b))
}

// ---------- 索引：启动时建一次，之后都在内存里 ----------

const chunks = loadChunks()
const chunkVectors = await embedAll(chunks.map((c) => c.text))

interface Hit {
  score: number
  chunk: Chunk
}

async function search(query: string, topK: number): Promise<Hit[]> {
  const [queryVector] = await embedAll([query])
  return chunks
    .map((chunk, i) => ({ score: cosine(queryVector, chunkVectors[i]), chunk }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// 把检索结果拼成给模型看的文本。★ 来源（文件名 + 标题）必须带上，否则没法溯源。
function formatHits(hits: Hit[]): string {
  return hits
    .map((h, i) => `【片段 ${i + 1}｜来源：${h.chunk.source} › ${h.chunk.title}｜相似度 ${h.score.toFixed(3)}】\n${h.chunk.text}`)
    .join('\n\n')
}

// ---------- 工具：★ 这里 execute 变成 async 了 ----------

interface Tool<S extends z.ZodType> {
  description: string
  argsSchema: S
  // ★ 第 3 课是 (args) => string（同步）。检索要先嵌入 query，得发网络请求，
  //   同步签名在这里第一次不够用。改动很小，但它是后面所有复杂度的源头 ——
  //   一旦工具有了 IO，你就需要并发控制、超时、重试、取消……
  execute: (args: z.infer<S>) => Promise<string>
}

type AnyTool = Tool<any>

function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}

const TOP_K = 3

const toolRegistry = {
  search_knowledge_base: defineTool({
    description:
      '在本地知识库里检索相关片段。知识库内容是 TypeScript 和 ES6 的教程摘录。' +
      '当你需要确认某个语法细节、或者不确定知识库里有没有相关内容时，调用它。' +
      '可以用不同的关键词多查几次。',
    argsSchema: z.object({
      query: z.string().min(1).describe('检索用的自然语言问题或关键词'),
      top_k: z.number().int().min(1).max(8).default(TOP_K).describe('返回几个片段，默认 3'),
    }),
    execute: async ({ query, top_k }) => {
      const hits = await search(query, top_k)
      return JSON.stringify({
        query,
        // ★ 分数一并给模型。让它自己判断"这几条到底相不相关"，
        //   比我们拍一个阈值硬卡要稳 —— 相似度分数跨 query 本来就不可比。
        results: hits.map((h) => ({
          source: h.chunk.source,
          title: h.chunk.title,
          score: Number(h.score.toFixed(4)),
          text: h.chunk.text,
        })),
      })
    },
  }),
}

const registry: Record<string, AnyTool> = toolRegistry

function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

const toolDefs = Object.entries(toolRegistry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: toToolSchema(t.argsSchema) },
}))

// ---------- 通用的工具执行器（跟第 3 课同一套两道关，只是变成了 async） ----------

async function executeTool(toolCall: { id: string; function: { name: string; arguments: string } }): Promise<string> {
  const tool = registry[toolCall.function.name]
  if (!tool) return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })

  let raw: unknown
  try {
    raw = JSON.parse(toolCall.function.arguments)
  } catch {
    return JSON.stringify({ error: `参数不是合法 JSON: ${toolCall.function.arguments}` })
  }

  const parsed = tool.argsSchema.safeParse(raw)
  if (!parsed.success) {
    return JSON.stringify({ error: `参数校验失败: ${parsed.error.message}` })
  }

  try {
    // 唯一的变化：这里要 await 了
    return await tool.execute(parsed.data)
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- 对话模型 ----------

async function callModel(messages: Message[], withTools = true): Promise<AssistantMessage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(withTools ? { model: MODEL, messages, tools: toolDefs } : { model: MODEL, messages }),
  })
  if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)
  return (await res.json()).choices[0].message as AssistantMessage
}

// ---------- Demo A：朴素 RAG（检索一次 → 塞进 prompt → 问一次） ----------

// ★ 朴素 RAG 的全部秘密就是这一个模板。检索是**代码**触发的，不是模型决定的。
async function naiveRag(question: string): Promise<string> {
  const hits = await search(question, TOP_K)

  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是一个严谨的助手，**只根据下面提供的资料**回答问题。\n' +
        '如果资料里没有足够信息，直接说「资料里没有提到」，不要用你自己的知识补充。\n' +
        '回答末尾用 [来源: 文件名] 标注依据。',
    },
    { role: 'user', content: `资料：\n\n${formatHits(hits)}\n\n---\n\n问题：${question}` },
  ]

  return (await callModel(messages, false)).content ?? ''
}

// ---------- Demo B：Agentic RAG（检索变成工具，模型自主决定） ----------

const MAX_ITERATIONS = 10

async function agenticRag(question: string): Promise<string> {
  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是一个严谨的助手。你可以调用 search_knowledge_base 在本地知识库（TypeScript / ES6 教程摘录）中检索。\n' +
        '需要确认语法细节时就去检索，可以换关键词多查几次。\n' +
        '回答必须基于检索到的片段，并标注来源；知识库里确实没有的，直接说没有，不要编。',
    },
    { role: 'user', content: question },
  ]

  let searches = 0

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const msg = await callModel(messages)

    if (!msg.tool_calls?.length) {
      console.log(`  [第 ${i} 轮] 模型给出最终回答，循环结束（共检索 ${searches} 次）`)
      return msg.content ?? ''
    }

    messages.push(msg)
    for (const toolCall of msg.tool_calls) {
      // 日志用的解析，失败不该影响主流程 —— arguments 是模型给的，可能不是合法 JSON
      let label = toolCall.function.arguments
      try {
        label = (JSON.parse(toolCall.function.arguments) as { query?: string }).query ?? label
      } catch {
        /* 保持原始字符串 */
      }
      searches++
      console.log(`  [第 ${i} 轮] 🔍 ${label}`)
      const result = await executeTool(toolCall)
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }

  throw new Error(`超过最大轮数 ${MAX_ITERATIONS}，强制终止`)
}

// ---------- REPL（沿用第 4 课的思路：自己排队，rl.question 在管道输入下会丢行） ----------

function createLineQueue() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const buffered: string[] = []
  let pending: ((line: string) => void) | null = null
  let closed = false

  rl.on('line', (line) => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve(line)
    } else {
      buffered.push(line)
    }
  })
  rl.on('close', () => {
    closed = true
    if (pending) {
      const resolve = pending
      pending = null
      resolve('')
    }
  })

  return {
    async ask(prompt: string): Promise<string> {
      if (buffered.length) {
        // ★ 从管道喂进来的输入不会像终端那样自动回显，这里补一次。
        //   不补的话，`npm run l5:test` 的输出里根本分不清哪段回答对应哪个问题。
        const line = buffered.shift() as string
        console.log(`${prompt}${line}`)
        return line
      }
      if (closed) return ''
      process.stdout.write(prompt)
      return new Promise<string>((resolve) => {
        pending = resolve
      })
    },
    close: () => rl.close(),
  }
}

function divider(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)
}

// ---------- 运行 ----------

if (!API_KEY || !EMB_API_KEY) {
  throw new Error('缺少 API Key。需要 .env 里的 DEEPSEEK_API_KEY 和 SILICONFLOW_API_KEY（见 .env.example）')
}

divider('建索引')
console.log(`  语料：${DOCS_DIR}`)
console.log(`  ${chunks.length} 块，已就绪（缓存命中时不会发请求）`)

// Demo A 与 Demo B 用**同一个问题**，方便对比两种接法的差别
const QUESTION = 'async 函数和 Promise 到底什么关系？'

divider('Demo A：朴素 RAG（代码决定检索一次，然后问一次）')
console.log(`  问题：${QUESTION}\n`)
console.log(await naiveRag(QUESTION))

divider('Demo B：Agentic RAG（检索是工具，模型自己决定查几次）')
// 这个问题需要跨两篇语料，一次检索不够 —— 正是 Agentic 的用武之地
const MULTI_HOP = '我想定义一个「接收联合类型参数、并在函数体里做类型缩小」的泛型函数，语料里哪几篇跟这个有关？分别讲了什么？'
console.log(`  问题：${MULTI_HOP}\n`)
console.log(await agenticRag(MULTI_HOP))

divider('自由提问（Agentic RAG，输入 exit 退出）')
console.log('  试试问语料里没有的东西，比如「Vue 的响应式原理」—— 看它是老实说没有，还是编。')

const rl = createLineQueue()
while (true) {
  const line = (await rl.ask('\n你> ')).trim()
  if (!line || line === 'exit' || line === 'quit') break

  try {
    console.log(await agenticRag(line))
  } catch (e) {
    console.log(`  出错了：${String(e)}`)
  }
}
rl.close()

console.log('\n再见。')
