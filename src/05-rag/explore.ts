/**
 * 第 5 课：RAG —— 先只看检索层（不接模型）
 *
 * RAG 的全称是 Retrieval-Augmented Generation，但**难点全在 Retrieval**。
 * 大多数人第一次做 RAG 效果差，第一反应是去改 prompt —— 那是没用的。
 * 检索回来的东西本来就驴唇不对马嘴，再好的 prompt 也救不回来。
 *
 * 所以这个文件刻意不调用对话模型，只做四件事：
 *
 *   切块 → 向量化 → 存 → 按余弦相似度取 top-k
 *
 * 把它单独跑一遍，你能**亲眼看到**检索质量，再决定要不要把模型接上。
 * 配套命令：npm run l5:explore
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（归一化）服务端返回的向量**未必**是单位向量。很多教程直接点积当余弦用，
 *      在小数据上"看起来能跑"，换个模型就全错。本文件把每个向量的范数 ‖v‖ 打出来，
 *      让你自己看，并且余弦一律用显式范数计算 —— 两种情况下都对。
 *
 *   ★ 2（切块大小）块太大，一个块里混了好几个主题，向量被"平均"掉，检索就不准；
 *      块太小，答案正好被切断，模型拿到半句话。本文件最后有个对照实验：
 *      同样的问题，用「整篇当一块」检索，分数会明显掉下来。
 *
 *   ★ 3（阈值）相似度分数**跨 query 不可比**。"0.6 以上才算相关"这种阈值，
 *      换个问法就废。真实系统的做法是接一个 reranker，不是拍一个魔法数字。
 *
 *   ★ 4（embedding 是另一家）DeepSeek 没有 embedding 接口（/v1/embeddings 返回 404），
 *      所以本课外接了硅基流动的 BAAI/bge-m3。**另一家厂商、另一套 key、另一份账单。**
 *      这是 RAG 工程里第一个要接受的现实。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(HERE, 'docs')
const CACHE_FILE = path.join(HERE, '.cache', 'embeddings.json')

// ---------- 配置 ----------

// ★ 注意这里跟第 1~4 课的 DeepSeek 配置有个**路径不对称**：
//   DeepSeek 的 base 不带 /v1（拼出来是 ${BASE_URL}/chat/completions）
//   SiliconFlow 的 base 带 /v1（拼出来是 ${EMB_BASE_URL}/embeddings）
// 抄第 4 课的配置直接改 key，就会得到一个 404。这是个真会踩的坑。
const EMB_BASE_URL = process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1'
const EMB_API_KEY = process.env.SILICONFLOW_API_KEY
const EMB_MODEL = process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3'

// ★ bge-m3 的向量维度固定 1024，且**不能**通过 dimensions 参数改 ——
// dimensions 只支持 Qwen/Qwen3 系列，给 bge-m3 传了会直接 400（code 20015）。
const BATCH_SIZE = 16

// ---------- 1. 读语料 ----------

interface Doc {
  source: string
  text: string
}

function loadDocs(): Doc[] {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ source: f, text: fs.readFileSync(path.join(DOCS_DIR, f), 'utf8') }))
}

// ---------- 2. 切块 ----------

const CHUNK_SIZE = 300 // 每个块的目标字符数
const CHUNK_OVERLAP = 60 // 相邻块重叠的字符数，防止答案正好被切断
const MIN_CHUNK_SIZE = 40 // 比这更短的块直接丢掉（退化块只会稀释检索结果）

interface Chunk {
  source: string // 来自哪个文件 —— 用来溯源
  title: string // 最近的标题 —— 用来溯源，也帮模型快速判断主题
  text: string
}

// ★ 丢掉正文开始之前的内容：那里是「来源 / 版权」这类元信息。
//   元信息块是检索里的纯噪音 —— 它对**任何** query 都会得到一个不高不低的相似度，
//   于是经常挤掉真正相关的片段。过滤掉之后再看下面的检索结果，top-3 会明显干净。
//   这是本课性价比最高的一次改动，一行代码。
function stripFrontMatter(text: string): string {
  const firstHeading = text.search(/^#\s/m)
  return firstHeading >= 0 ? text.slice(firstHeading) : text
}

// 两级切分：先用标题切成语义段落，段落还太长再按窗口滑。
// 标题是作者已经帮我们画好的主题边界，白白扔掉很可惜 ——
// 这也是为什么"给文档加好标题"对 RAG 效果有实打实的帮助。
function chunkDoc(source: string, raw: string): Chunk[] {
  const text = stripFrontMatter(raw)
  const sections: { title: string; body: string[] }[] = []
  let title = source
  let body: string[] = []

  for (const line of text.split('\n')) {
    // 一级标题也当成标题（它是文章标题，正好给开头那段当 title）。
    // 早先这里只认 ## 和 ###，结果 `# Module 的语法` 那一行被当成了正文，
    // 自己变成一个只有标题、没有内容的块 —— 它跟什么 query 都"有点像"，
    // 于是老是冒到 top-1 去占位。这种块叫退化块，是切块代码最常见的 bug。
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
    // 太短的块（只有一个词、半行代码）检索价值几乎为零，只会稀释结果
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

// 对照组：整篇当成一个块，完全不切。
// 用来演示"切块大小"这件事到底有多要紧（见文件末尾的对照实验）。
function chunkWholeDoc(source: string, raw: string): Chunk[] {
  return [{ source, title: source, text: stripFrontMatter(raw).trim() }]
}

// ---------- 3. 向量化（带磁盘缓存） ----------

interface EmbedResponse {
  data: { embedding: number[]; index: number }[]
}

async function embedRaw(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${EMB_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMB_API_KEY}`,
    },
    // input 传**字符串数组**就是批量嵌入，建索引时能少发很多请求。
    // 单条上限 8192 tokens，我们 300 字的块离得很远。
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
  })

  if (!res.ok) {
    // ★ SiliconFlow 的错误信封是 {code, message, data}，**不是** OpenAI 的 {error:{...}}。
    // 所以别写 res.json().error.message —— 那是 undefined。
    // 第 1~4 课一直用的 await res.text() 在这里刚好是对的。
    throw new Error(`嵌入 API 错误 ${res.status}: ${await res.text()}`)
  }

  const json = (await res.json()) as EmbedResponse
  return json.data.map((d) => d.embedding)
}

type Cache = Record<string, number[]>

function loadCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache
  } catch {
    return {} // 首次运行、或缓存文件坏了，都当作空缓存
  }
}

function saveCache(cache: Cache): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
}

// 缓存键 = 模型 + 文本哈希。换模型会自动失效，不会串味。
function cacheKey(text: string): string {
  return `${EMB_MODEL}:${crypto.createHash('sha1').update(text).digest('hex')}`
}

// 缓存的意义是**速度 + 离线可复现**，不是为了省钱 ——
// bge-m3 本身是免费模型，但每次跑课都等一遍几十条嵌入请求，体验很差。
async function embedAll(texts: string[]): Promise<number[][]> {
  const cache = loadCache()
  const vectors: (number[] | null)[] = texts.map((t) => cache[cacheKey(t)] ?? null)

  const missing: number[] = []
  for (let i = 0; i < texts.length; i++) if (!vectors[i]) missing.push(i)

  if (!missing.length) {
    console.log(`  全部命中磁盘缓存（${texts.length} 条），本次没有发起任何请求`)
    return vectors as number[][]
  }

  console.log(`  缓存命中 ${texts.length - missing.length}/${texts.length}，需要新嵌入 ${missing.length} 条`)

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const idx = missing.slice(i, i + BATCH_SIZE)
    const fresh = await embedRaw(idx.map((j) => texts[j]))
    idx.forEach((j, k) => {
      cache[cacheKey(texts[j])] = fresh[k]
      vectors[j] = fresh[k]
    })
    process.stdout.write(`\r  已嵌入 ${Math.min(i + BATCH_SIZE, missing.length)}/${missing.length}`)
  }
  process.stdout.write('\n')

  saveCache(cache)
  return vectors as number[][]
}

// ---------- 4. 余弦相似度 ----------

function norm(v: number[]): number {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum)
}

// ★ 用显式范数算余弦，不去假设服务端有没有帮我们归一化。
// 如果服务端已经归一化（‖v‖ ≈ 1），这个式子和直接点积等价，只是多两次 sqrt ——
// 而如果没归一化，直接点积就是错的。所以永远这么写，不要图省事。
function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (norm(a) * norm(b))
}

// ---------- 检索 ----------

interface Hit {
  score: number
  chunk: Chunk
}

async function retrieve(query: string, chunks: Chunk[], vectors: number[][], topK: number): Promise<Hit[]> {
  const [queryVector] = await embedAll([query])
  return chunks
    .map((chunk, i) => ({ score: cosine(queryVector, vectors[i]), chunk }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// ---------- 运行 ----------

function divider(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)
}

function preview(text: string, max = 70): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function main(): Promise<void> {
  if (!EMB_API_KEY) {
    throw new Error('缺少 SILICONFLOW_API_KEY，请在 .env 里配置（见 .env.example）')
  }

  return run()
}

async function run(): Promise<void> {
  divider('1. 语料')
  const docs = loadDocs()
  console.log(`  ${DOCS_DIR}`)
  console.log(`  ${docs.length} 篇，共 ${docs.reduce((n, d) => n + d.text.length, 0)} 字`)

  divider('2. 切块')
  const chunks = docs.flatMap((d) => chunkDoc(d.source, d.text))
  console.log(`  CHUNK_SIZE=${CHUNK_SIZE}  CHUNK_OVERLAP=${CHUNK_OVERLAP}`)
  console.log(`  ${docs.length} 篇 → ${chunks.length} 块\n`)
  for (const c of chunks.slice(0, 5)) {
    console.log(`  · [${c.source} › ${c.title}] ${preview(c.text)}`)
  }
  console.log(`  …… 其余 ${chunks.length - 5} 块略`)

  divider('3. 向量化')
  console.log(`  模型 ${EMB_MODEL}（${EMB_BASE_URL}）`)
  const vectors = await embedAll(chunks.map((c) => c.text))
  const dim = vectors[0].length
  console.log(`  维度 ${dim}，共 ${vectors.length} 个向量`)

  // ★ 这一步是本文件最该看懂的地方。
  const norms = vectors.map(norm)
  const lo = Math.min(...norms)
  const hi = Math.max(...norms)
  console.log(`\n  ★ 向量范数 ‖v‖：最小 ${lo.toFixed(6)}，最大 ${hi.toFixed(6)}`)
  console.log(`    前 3 个：${norms.slice(0, 3).map((n) => n.toFixed(6)).join(', ')}`)
  if (lo > 0.999 && hi < 1.001) {
    console.log('    → 全都约等于 1，说明服务端已经帮我们做了 L2 归一化。')
    console.log('      这时余弦 ≈ 点积。但**不要**据此就省掉范数 —— 换个厂商就未必了。')
  } else {
    console.log('    → 明显不等于 1，说明服务端**没有**归一化。')
    console.log('      这种时候如果直接拿点积当余弦用，排序就是错的。')
  }

  divider('4. 检索')
  const defaultQueries = [
    '泛型的类型参数可以有默认值吗？',
    'async 函数和 Promise 是什么关系？',
    'interface 能不能继承一个 class？',
    'typeof 运算符怎么用来缩小类型？',
    '模块默认导出用哪个关键字？',
    // 语料里**没有**这个 —— 用来观察"检索不到"时分数长什么样
    'Vue 的响应式原理是什么？',
  ]
  const queries = process.argv.slice(2).length ? process.argv.slice(2) : defaultQueries

  const TOP_K = 3
  for (const q of queries) {
    const hits = await retrieve(q, chunks, vectors, TOP_K)
    console.log(`\n  查询：${q}`)
    for (const hit of hits) {
      console.log(`    ${hit.score.toFixed(4)}  ${hit.chunk.source} › ${hit.chunk.title}`)
      console.log(`            ${preview(hit.chunk.text, 60)}`)
    }
    // ★ "top-1 也不高" 就是一个警报：要么语料里真没有，要么切块/模型有问题。
    // 真实系统在这里要**明确告诉模型"没检索到"**，而不是把这三条不相干的硬塞给它 ——
    // 硬塞的结果就是模型一本正经地编。
  }

  divider('5. 对照实验：切块大小到底有多要紧')
  const probe = '泛型的类型参数可以有默认值吗？'
  console.log(`  同一个问题：${probe}`)
  console.log('  三种粒度分别建索引，看 top-1 落在哪、分数多高，')
  console.log('  ★ 以及你要为此往 prompt 里**塞多少字** —— 最后这一项才是真正的代价。\n')

  const wholeChunks = docs.flatMap((d) => chunkWholeDoc(d.source, d.text))
  const allInOne: Chunk[] = [
    { source: '（全部语料）', title: '全部语料', text: docs.map((d) => d.text).join('\n\n') },
  ]

  const avg = (cs: Chunk[]): number => Math.round(cs.reduce((n, c) => n + c.text.length, 0) / cs.length)
  const tiers: { label: string; chunks: Chunk[] }[] = [
    { label: `细粒度切块（每块约 ${CHUNK_SIZE} 字，共 ${chunks.length} 块）`, chunks },
    { label: `整篇作一块（每块约 ${avg(wholeChunks)} 字，共 ${wholeChunks.length} 块）`, chunks: wholeChunks },
    { label: `全部语料作一块（1 块，约 ${allInOne[0].text.length} 字）`, chunks: allInOne },
  ]

  for (const tier of tiers) {
    const tierVectors = await embedAll(tier.chunks.map((c) => c.text))
    const [top] = await retrieve(probe, tier.chunks, tierVectors, 1)
    const where = top.chunk.title === top.chunk.source ? top.chunk.source : `${top.chunk.source} › ${top.chunk.title}`
    console.log(`  ${tier.label}`)
    console.log(`    top-1  ${top.score.toFixed(4)}  ${where}`)
    console.log(`    要注入 prompt 的字数：${top.chunk.text.length}\n`)
  }

  console.log('  ★ 看前两行：分数只差 0.03，看起来"差不多" —— 但注入量差了 3.5 倍。')
  console.log('    第三行分数掉到 0.55，可你依然得把一万两千字全塞进去才能拿到那一句答案。')
  console.log('    多出来的那些全是无关内容 —— 它们会稀释信号、推高成本，')
  console.log('    还会把模型带偏（第 4 课讲的"上下文膨胀"在这里又出现了一次）。')
  console.log('    所以：**分数相近 ≠ 效果相近**。看检索质量不能只看相似度，')
  console.log('    要看"命中这一块干不干净"。')
  console.log('\n  （顺带一提：这也是为什么"把整篇文档丢给模型"这种朴素做法走不远 ——')
  console.log('    语料一变大，你就塞不下了。切块不是可选优化，是必需。）')

  divider('小结')
  console.log('  检索层没问题了，才轮到接模型 —— 也就是 index.ts 干的事。')
  console.log('  想换个问题试试：npm run l5:explore -- "你的问题"')
}

await main()
