import JSZip from "jszip"
import { arrayBufferToBase64 } from "@/lib/utils"

export interface SourceFile {
  /** Path relatif di repositori (root). */
  path: string
  file: File | Blob
  size: number
}

export interface RepoRef {
  owner: string
  repo: string
  branch: string
  token: string
}

export interface UpdatePlan {
  added: SourceFile[]
  modified: SourceFile[]
  unchanged: SourceFile[]
  /** Path file lama yang tidak ada di sumber baru, akan dihapus. */
  removed: string[]
  headSha: string
  baseTreeSha: string
  /** Mode file lama (mis. executable) agar tidak hilang saat diganti. */
  modes: Map<string, string>
  /** Peta path -> sha untuk file yang akan dihapus/diganti (info saja). */
}

const IGNORED = (p: string) =>
  p.startsWith("__MACOSX/") || p.endsWith(".DS_Store") || p.startsWith(".git/") || p === ".git"

function cleanPath(p: string): string {
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((x) => x && x !== ".")
  // Tolak path berbahaya seperti ../ yang keluar dari root
  if (parts.some((x) => x === "..")) return ""
  return parts.join("/")
}

/** Jika semua file berada dalam satu folder induk yang sama, buang folder induk itu. */
function stripSingleRoot(items: { path: string; file: File | Blob }[]): SourceFile[] {
  const clean = items
    .map((i) => ({ ...i, path: cleanPath(i.path) }))
    .filter((i) => i.path && !IGNORED(i.path))
  let root: string | null = null
  let single = clean.length > 0
  for (const i of clean) {
    const parts = i.path.split("/")
    if (parts.length < 2) {
      single = false
      break
    }
    if (root === null) root = parts[0]
    else if (root !== parts[0]) {
      single = false
      break
    }
  }
  const prefix = single && root ? `${root}/` : ""
  return clean.map((i) => ({
    path: prefix ? i.path.slice(prefix.length) : i.path,
    file: i.file,
    size: i.file.size,
  }))
}

export function sourceFromFolder(files: File[]): SourceFile[] {
  return stripSingleRoot(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })))
}

export function sourceFromHtml(files: File[]): SourceFile[] {
  // File HTML tunggal: nama file dipakai apa adanya di root repositori
  return files.map((f) => ({ path: cleanPath(f.name), file: f, size: f.size }))
}

export async function sourceFromZip(file: File): Promise<SourceFile[]> {
  const zip = await new JSZip().loadAsync(file)
  const items: { path: string; file: Blob }[] = []
  for (const [name, entry] of Object.entries(zip.files) as [string, JSZip.JSZipObject][]) {
    if (entry.dir) continue
    items.push({ path: name, file: await entry.async("blob") })
  }
  return stripSingleRoot(items)
}

/** SHA-1 blob Git: sha1("blob <ukuran>\0" + isi). Dipakai untuk melewati file yang tidak berubah. */
async function gitBlobSha(blob: Blob): Promise<string> {
  const content = new Uint8Array(await blob.arrayBuffer())
  const header = new TextEncoder().encode(`blob ${content.length}\0`)
  const data = new Uint8Array(header.length + content.length)
  data.set(header, 0)
  data.set(content, header.length)
  const digest = await crypto.subtle.digest("SHA-1", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function api(ref: RepoRef) {
  const base = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
  const branchPath = ref.branch.split("/").map(encodeURIComponent).join("/")
  const call = async (url: string, init?: RequestInit): Promise<any> => {
    const MAX = 4
    for (let attempt = 1; ; attempt++) {
      let res: Response
      try {
        res = await fetch(url, {
          ...init,
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${ref.token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
        })
      } catch {
        // Gangguan jaringan: coba lagi dengan jeda bertahap
        if (attempt >= MAX) throw new Error("Koneksi terputus. Periksa jaringan Anda lalu coba lagi.")
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
        continue
      }
      const data = await res.json().catch(() => ({}))
      if (res.ok) return data
      const msg: string = data?.message || `Permintaan gagal (${res.status})`
      const limited = res.status === 429 || (res.status === 403 && /rate limit|abuse|secondary/i.test(msg))
      if ((limited || res.status >= 500) && attempt < MAX) {
        const retryAfter = Number(res.headers.get("retry-after"))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1500 * 2 ** (attempt - 1)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      const err: any = new Error(
        res.status === 401 ? "Token tidak valid atau kedaluwarsa"
        : res.status === 403 && !limited ? "Token tidak punya izin menulis ke repositori ini"
        : res.status === 422 && /fast forward/i.test(msg) ? "Repositori berubah saat proses berjalan. Coba lagi."
        : msg
      )
      err.status = res.status
      throw err
    }
  }
  return { base, branchPath, call }
}

export async function buildPlan(ref: RepoRef, source: SourceFile[]): Promise<UpdatePlan> {
  const { base, branchPath, call } = api(ref)
  let headSha: string
  try {
    headSha = (await call(`${base}/git/ref/heads/${branchPath}`)).object.sha
  } catch (e: any) {
    if (e.status === 404 || e.status === 409)
      throw new Error("Cabang atau repositori kosong. Gunakan mode Unggah Biasa untuk commit pertama.")
    throw e
  }
  const commit = await call(`${base}/git/commits/${headSha}`)
  const tree = await call(`${base}/git/trees/${commit.tree.sha}?recursive=1`)
  if (tree.truncated) throw new Error("Repositori terlalu besar untuk diperbarui sekaligus")

  const existing = new Map<string, string>()
  const modes = new Map<string, string>()
  for (const n of tree.tree as any[])
    if (n.type === "blob") {
      existing.set(n.path, n.sha)
      modes.set(n.path, n.mode)
    }

  // Hapus duplikat path di sumber (yang terakhir menang)
  const tooBig = source.find((s) => s.size > 95 * 1024 * 1024)
  if (tooBig) throw new Error(`${tooBig.path} lebih dari 95 MB, melewati batas file GitHub`)
  const unique = new Map<string, SourceFile>()
  for (const s of source) unique.set(s.path, s)

  const added: SourceFile[] = []
  const modified: SourceFile[] = []
  const unchanged: SourceFile[] = []
  for (const s of unique.values()) {
    const old = existing.get(s.path)
    if (!old) added.push(s)
    else if ((await gitBlobSha(s.file)) === old) unchanged.push(s)
    else modified.push(s)
  }
  const removed = [...existing.keys()].filter((p) => !unique.has(p)).sort()

  return { added, modified, unchanged, removed, headSha, baseTreeSha: commit.tree.sha, modes }
}

export async function applyPlan(
  ref: RepoRef,
  plan: UpdatePlan,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const { base, branchPath, call } = api(ref)
  const changed = [...plan.added, ...plan.modified]
  const entries: any[] = []
  let done = 0
  const total = changed.length

  // Buat blob dengan konkurensi terbatas
  const queue = [...changed]
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const content = arrayBufferToBase64(await s.file.arrayBuffer())
      const blob = await call(`${base}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content, encoding: "base64" }),
      })
      entries.push({ path: s.path, mode: plan.modes.get(s.path) || "100644", type: "blob", sha: blob.sha })
      onProgress?.(++done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, total)) }, worker))

  for (const p of plan.removed) entries.push({ path: p, mode: "100644", type: "blob", sha: null })

  // Git menolak tree dengan ribuan entri dalam satu permintaan: pecah menjadi beberapa tahap
  let baseTree = plan.baseTreeSha
  const CHUNK = 300
  for (let i = 0; i < entries.length; i += CHUNK) {
    const t = await call(`${base}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTree, tree: entries.slice(i, i + CHUNK) }),
    })
    baseTree = t.sha
  }

  const commit = await call(`${base}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Perbarui: +${plan.added.length} ~${plan.modified.length} -${plan.removed.length}`,
      tree: baseTree,
      parents: [plan.headSha],
    }),
  })
  await call(`${base}/git/refs/heads/${branchPath}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  })
  return commit.sha
}
