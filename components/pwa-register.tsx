"use client"

import { useEffect } from "react"
import { toast } from "sonner"

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

  // Daftarkan service worker (hanya pada build produksi)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    if (process.env.NODE_ENV !== "production") {
      // Mode pengembangan: pastikan tidak ada service worker lama yang menahan cache
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => registrations.forEach((r) => r.unregister()))
        .catch(() => {})
      return
    }

    let cancelled = false
    let controlled = Boolean(navigator.serviceWorker.controller)
    let refreshing = false

    const notifyUpdate = (registration: ServiceWorkerRegistration) => {
      toast("Versi baru tersedia", {
        id: "pwa-update",
        description: "Muat ulang untuk memakai versi terbaru.",
        duration: Infinity,
        action: {
          label: "Muat ulang",
          onClick: () => {
            if (registration.waiting) {
              registration.waiting.postMessage({ type: "SKIP_WAITING" })
            } else {
              window.location.reload()
            }
          },
        },
      })
    }

    const onControllerChange = () => {
      if (!controlled) {
        // Instalasi pertama: service worker baru mengambil alih, tidak perlu muat ulang
        controlled = true
        return
      }
      if (refreshing) return
      refreshing = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return
        if (registration.waiting && navigator.serviceWorker.controller) {
          notifyUpdate(registration)
        }
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing
          if (!worker) return
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              notifyUpdate(registration)
            }
          })
        })
      })
      .catch((err) => {
        console.warn("Service Worker registration failed: ", err)
      })

    return () => {
      cancelled = true
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
    }
  }, [])

  return null
}
