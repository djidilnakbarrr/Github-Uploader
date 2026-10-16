import { get, set, del, update } from "idb-keyval"
import { arrayBufferToBase64, encodeRepoPath } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/* Tipe                                                                */
/* ------------------------------------------------------------------ */

export interface QueueItem {
  id: string
  file: File
  /** Path relatif di repositori (tanpa target folder). */
  path: string
}

interface StoredItem {
  id: string
  name: string
  rel: string
  type: string
  lastModified: number
  blob: Blob
}

export interface UploadTarget {
  owner: string
  repo: string
  branch: string
  token: string
  targetFolder: string
  commitMessageTemplate: string
}

/* ------------------------------------------------------------------ */
/* Antrean yang tahan ditutup (disimpan di IndexedDB)                  */
/* ------------------------------------------------------------------ */

const QUEUE_KEY = "github-upload-queue-v1"
const DONE_KEY = "github-upload-done-v1"

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createItem(file: File): QueueItem {
  return { id: newId(), file, path: file.webkitRelativePath || file.name }
}

export async function saveQueue(items: QueueItem[]): Promise<void> {
  if (items.length === 0) {
    await del(QUEUE_KEY)
    return
  }
  const stored: StoredItem[] = items.map((item) => ({
    id: item.id,
    name: item.file.name,
    rel: item.file.webkitRelativePath || "",
    type: item.file.type,
    lastModified: item.file.lastModified,
    blob: item.file,
  }))
  await set(QUEUE_KEY, stored)
}

export async function loadQueue(): Promise<QueueItem[]> {
  const stored = await get<StoredItem[]>(QUEUE_KEY)
  if (!Array.isArray(stored)) return []
  const doneRaw = await get<string[]>(DONE_KEY)
  const done = new Set<string>(Array.isArray(doneRaw) ? doneRaw : [])
  const items: QueueItem[] = []
  for (const s of stored) {
    if (!s || typeof s.id !== "string" || typeof s.name !== "string" || !(s.blob instanceof Blob)) continue
    if (done.has(s.id)) continue
    const file = new File([s.blob], s.name, { type: s.type || "", lastModified: s.lastModified })
    const rel = typeof s.rel === "string" ? s.rel : ""
    if (rel) Object.defineProperty(file, "webkitRelativePath", { value: rel })
    items.push({ id: s.id, file, path: rel || s.name })
  }
  return items
}

export async function markDone(id: string): Promise<void> {
  await update<string[]>(DONE_KEY, (value) => {
    const list = Array.isArray(value) ? value : []
    list.push(id)
    return list
  })
}

export async function clearDone(): Promise<void> {
  await del(DONE_KEY)
}

/* ------------------------------------------------------------------ */
/* Pendukung latar belakang                                            */
/* ------------------------------------------------------------------ */

export const UPLOAD_GAP_MS = 1000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Menjaga layar tetap menyala selama unggahan, dan mengambilnya lagi saat tab kembali terlihat. */
export function createWakeLock() {
  let sentinel: WakeLockSentinel | null = null
  let active = false

  const acquire = async () => {
    if (!active || typeof document === "undefined" || document.visibilityState !== "visible") return
    if (typeof navigator === "undefined" || !navigator.wakeLock) return
    try {
      const lock = await navigator.wakeLock.request("screen")
      if (!active) {
        lock.release().catch(() => {})
        return
      }
      sentinel = lock
      lock.addEventListener("release", () => {
        if (sentinel === lock) sentinel = null
      })
    } catch {
      // Ditolak (mis. baterai hemat): unggahan tetap berjalan tanpa wake lock
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === "visible" && !sentinel) void acquire()
  }

  return {
    start() {
      active = true
      document.addEventListener("visibilitychange", onVisibility)
      void acquire()
    },
    stop() {
      active = false
      document.removeEventListener("visibilitychange", onVisibility)
      if (sentinel) {
        sentinel.release().catch(() => {})
        sentinel = null
      }
    },
  }
}

/** Mencegah dua tab mengunggah bersamaan. Mengembalikan false jika sudah ada unggahan lain. */
export async function withUploadLock(fn: () => Promise<void>): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
    return navigator.locks.request("github-uploader-upload", { ifAvailable: true }, async (lock) => {
      if (!lock) return false
      await fn()
      return true
    })
  }
  await fn()
  return true
}

export function waitForOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("online", done)
      resolve()
    }
    window.addEventListener("online", done)
  })
}

export function requestNotificationPermission(): void {
  try {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      const result = Notification.requestPermission() as Promise<NotificationPermission> | undefined
      if (result && typeof result.catch === "function") result.catch(() => {})
    }
  } catch {
    // Diabaikan: notifikasi hanya tambahan
  }
}

/** Notifikasi hanya ditampilkan jika aplikasi sedang tidak terlihat. */
export async function notifyIfHidden(title: string, body: string): Promise<void> {
  try {
    if (typeof document === "undefined" || document.visibilityState === "visible") return
    if (!("Notification" in window) || Notification.permission !== "granted") return
    const options: NotificationOptions = {
      body,
      icon: "/icon-192x192.png",
      badge: "/icon-192x192.png",
      tag: "github-uploader-upload",
    }
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (registration) {
      await registration.showNotification(title, options)
      return
    }
    new Notification(title, options)
  } catch {
    // Diabaikan: notifikasi hanya tambahan
  }
}

/* ------------------------------------------------------------------ */
/* Unggah satu file dengan percobaan ulang                             */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 5
const MAX_WAIT_MS = 120000

class RetryableError extends Error {
  delayMs: number
  constructor(message: string, delayMs: number) {
    super(message)
    this.delayMs = delayMs
  }
}

class FatalUploadError extends Error {}

function backoff(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)
}

function rateLimitDelayMs(res: Response, message: string): number | null {
  const retryAfter = res.headers.get("retry-after")
  if ((res.status === 403 || res.status === 429) && retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000) + 500
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - Date.now() + 1000)
    return 60000
  }
  if (res.status === 429) return 60000
  if (res.status === 403 && /rate limit/i.test(message)) return 60000
  return null
}

export async function uploadFileWithRetry(
  item: QueueItem,
  target: UploadTarget,
  onNotice?: (message: string) => void
): Promise<void> {
  const file = item.file
  const base64Content = arrayBufferToBase64(await file.arrayBuffer())

  let path = item.path
  if (target.targetFolder) path = `${target.targetFolder}/${path}`

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodeRepoPath(path)}`
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
  }
  const message = target.commitMessageTemplate.replace(/\{filename\}/g, file.name)

  let attempt = 0
  for (;;) {
    attempt++
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        onNotice?.("Anda offline. Unggahan dilanjutkan otomatis saat koneksi kembali.")
        await waitForOnline()
      }

      // Ambil sha jika file sudah ada (diperlukan untuk memperbarui)
      let sha: string | undefined
      const checkRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(target.branch)}`, {
        headers,
        cache: "no-store",
      })
      if (checkRes.ok) {
        const data = await checkRes.json()
        if (data && !Array.isArray(data) && data.sha) sha = data.sha
      } else {
        const wait = rateLimitDelayMs(checkRes, "")
        if (wait !== null) throw new RetryableError("Batas permintaan GitHub tercapai", wait)
        if (checkRes.status >= 500) throw new RetryableError("Server GitHub bermasalah", backoff(attempt))
      }

      const res = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: base64Content,
          branch: target.branch,
          ...(sha ? { sha } : {}),
        }),
      })
      if (res.ok) return

      const errData = await res.json().catch(() => ({}))
      const msg = errData && errData.message ? String(errData.message) : ""
      const wait = rateLimitDelayMs(res, msg)
      if (wait !== null) throw new RetryableError(msg || "Batas permintaan GitHub tercapai", wait)
      if (res.status >= 500) throw new RetryableError(msg || "Server GitHub bermasalah", backoff(attempt))
      if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) {
        throw new RetryableError(msg || "Konflik versi file", 500 + Math.floor(Math.random() * 500))
      }
      throw new FatalUploadError(`Gagal mengunggah ${file.name}${msg ? `: ${msg}` : ""}`)
    } catch (err) {
      if (err instanceof FatalUploadError) throw err

      let delay: number
      let reason: string
      if (err instanceof RetryableError) {
        delay = err.delayMs
        reason = err.message
      } else if (err instanceof TypeError) {
        // fetch gagal karena jaringan
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          attempt--
          continue
        }
        delay = backoff(attempt)
        reason = "Koneksi terputus"
      } else {
        throw err instanceof Error ? err : new Error(String(err))
      }

      if (delay > MAX_WAIT_MS) {
        throw new Error(
          `Gagal mengunggah ${file.name}: ${reason}. Coba lagi dalam ${Math.ceil(delay / 60000)} menit.`
        )
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Gagal mengunggah ${file.name}: ${reason}`)
      }
      if (delay >= 5000) {
        onNotice?.(`${reason}. Mencoba lagi dalam ${Math.ceil(delay / 1000)} detik...`)
      }
      await sleep(delay)
    }
  }
}
