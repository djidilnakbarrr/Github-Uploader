"use client"

import { useEffect } from "react"
import { toast } from "sonner"

const CHECK_INTERVAL_MS = 2 * 60 * 1000 // cek pembaruan tiap 2 menit
const RELOAD_GUARD_KEY = "pwa-last-auto-reload"

/** Ambil daftar skrip /_next/static/ dari sebuah teks HTML. */
function extractScripts(html: string): string[] {
  const out = new Set<string>()
  const re = /\/_next\/static\/[^"'\s<>)\\]+\.js/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.add(m[0])
  return Array.from(out)
}

/** Hapus service worker & cache lama, lalu muat ulang halaman. */
async function hardReload() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.()
    if (regs) await Promise.all(regs.map((r) => r.update().catch(() => {})))
  } catch {}
  try {
    if ("caches" in window) {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith("github-uploader-") || k.startsWith("githubupps-"))
          .map((k) => caches.delete(k))
      )
    }
  } catch {}
  window.location.reload()
}

export function PwaRegister() {
  // Pantau status koneksi
  useEffect(() => {
    const onOffline = () => {
      toast.warning("Anda sedang offline", {
        id: "pwa-connection",
        description: "Unggahan ke GitHub membutuhkan koneksi internet.",
      })
    }
    const onOnline = () => {
      toast.success("Koneksi kembali tersambung", { id: "pwa-connection" })
    }
    if (!navigator.onLine) onOffline()
    window.addEventListener("offline", onOffline)
    window.addEventListener("online", onOnline)
    return () => {
      window.removeEventListener("offline", onOffline)
      window.removeEventListener("online", onOnline)
    }
  }, [])

  // Pembaruan otomatis
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // Mode pengembangan: pastikan tidak ada service worker lama yang menahan cache
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => registrations.forEach((r) => r.unregister()))
          .catch(() => {})
      }
      return
    }

    let cancelled = false
    let reloading = false
    let pendingReload = false
    let registration: ServiceWorkerRegistration | undefined

    const isBusy = () => Boolean((window as any).__appBusy)

    // Muat ulang otomatis; jika sedang mengunggah, tunggu sampai selesai.
    const applyUpdate = () => {
      if (reloading || cancelled) return
      if (isBusy()) {
        if (!pendingReload) {
          pendingReload = true
          toast("Versi baru siap", {
            id: "pwa-update",
            description: "Akan dipasang otomatis setelah unggahan selesai.",
          })
          const wait = window.setInterval(() => {
            if (!isBusy()) {
              window.clearInterval(wait)
              pendingReload = false
              applyUpdate()
            }
          }, 1500)
        }
        return
      }
      // Cegah loop reload jika server tetap menyajikan versi yang berbeda
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0)
      if (Date.now() - last < 30_000) return
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
      reloading = true
      toast.loading("Memperbarui aplikasi...", { id: "pwa-update" })
      hardReload()
    }

    // Cara 1: service worker baru -> aktif sendiri -> muat ulang
    let controlled = Boolean("serviceWorker" in navigator && navigator.serviceWorker.controller)
    const onControllerChange = () => {
      if (!controlled) {
        controlled = true // instalasi pertama, tidak perlu muat ulang
        return
      }
      applyUpdate()
    }

    // Cara 2 (cadangan, juga untuk APK/WebView): bandingkan skrip halaman terbaru dengan yang sedang berjalan
    const checkFreshHtml = async () => {
      try {
        const res = await fetch(`/?_v=${Date.now()}`, { cache: "no-store", credentials: "same-origin" })
        if (!res.ok) return
        const fresh = extractScripts(await res.text())
        if (fresh.length === 0) return
        const current = new Set<string>()
        document.querySelectorAll("script[src]").forEach((el) => {
          try {
            current.add(new URL((el as HTMLScriptElement).src).pathname)
          } catch {}
        })
        performance.getEntriesByType("resource").forEach((e) => {
          try {
            current.add(new URL(e.name).pathname)
          } catch {}
        })
        if (fresh.some((src) => !current.has(src))) applyUpdate()
      } catch {}
    }

    const checkForUpdate = () => {
      if (cancelled || reloading || !navigator.onLine) return
      registration?.update().catch(() => {})
      checkFreshHtml()
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((reg) => {
          if (cancelled) return
          registration = reg
          // Jika ada worker yang menunggu, aktifkan langsung
          if (reg.waiting && navigator.serviceWorker.controller) {
            reg.waiting.postMessage({ type: "SKIP_WAITING" })
          }
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing
            if (!worker) return
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                worker.postMessage({ type: "SKIP_WAITING" })
              }
            })
          })
        })
        .catch((err) => console.warn("Service Worker registration failed: ", err))
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", checkForUpdate)
    window.addEventListener("online", checkForUpdate)
    const interval = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS)
    const first = window.setTimeout(checkForUpdate, 3000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.clearTimeout(first)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", checkForUpdate)
      window.removeEventListener("online", checkForUpdate)
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
      }
    }
  }, [])

  return null
}
