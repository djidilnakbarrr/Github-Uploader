"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Download, Share, SquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
  prompt: () => Promise<void>
}

declare global {
  interface Window {
    __pwaInstallEvent?: BeforeInstallPromptEvent | null
  }
}

function isStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true
}

function isIosDevice(): boolean {
  const ua = window.navigator.userAgent
  const iPadOs = /Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1
  return /iPhone|iPad|iPod/.test(ua) || iPadOs
}

export function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [ios, setIos] = useState(false)
  const [iosOpen, setIosOpen] = useState(false)

  useEffect(() => {
    if (isStandalone()) {
      setInstalled(true)
      return
    }

    setIos(isIosDevice())
    if (window.__pwaInstallEvent) setDeferred(window.__pwaInstallEvent)

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      const ev = e as BeforeInstallPromptEvent
      window.__pwaInstallEvent = ev
      setDeferred(ev)
    }
    const onAvailable = () => setDeferred(window.__pwaInstallEvent ?? null)
    const onInstalled = () => {
      window.__pwaInstallEvent = null
      setDeferred(null)
      setInstalled(true)
      toast.success("Aplikasi berhasil dipasang")
    }

    const media = window.matchMedia("(display-mode: standalone)")
    const onDisplayChange = (e: MediaQueryListEvent) => {
      if (e.matches) setInstalled(true)
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("pwa-install-available", onAvailable)
    window.addEventListener("appinstalled", onInstalled)
    media.addEventListener("change", onDisplayChange)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("pwa-install-available", onAvailable)
      window.removeEventListener("appinstalled", onInstalled)
      media.removeEventListener("change", onDisplayChange)
    }
  }, [])

  const handleInstall = async () => {
    const ev = deferred
    if (!ev) return
    try {
      await ev.prompt()
      const choice = await ev.userChoice
      if (choice.outcome === "dismissed") toast.info("Instalasi dibatalkan")
    } catch {
      toast.error("Tidak dapat membuka dialog instalasi")
    } finally {
      // Event hanya bisa dipakai satu kali
      window.__pwaInstallEvent = null
      setDeferred(null)
    }
  }

  if (installed) return null

  if (deferred) {
    return (
      <Button
        variant="outline"
        className="h-11 min-w-[44px] gap-2 px-3 sm:px-4"
        onClick={handleInstall}
        title="Install Aplikasi"
        aria-label="Install Aplikasi"
      >
        <Download className="h-5 w-5" />
        <span className="hidden sm:inline">Install Aplikasi</span>
      </Button>
    )
  }

  if (ios) {
    return (
      <>
        <Button
          variant="outline"
          className="h-11 min-w-[44px] gap-2 px-3 sm:px-4"
          onClick={() => setIosOpen(true)}
          title="Install Aplikasi"
          aria-label="Install Aplikasi"
        >
          <Download className="h-5 w-5" />
          <span className="hidden sm:inline">Install Aplikasi</span>
        </Button>
        <Dialog open={iosOpen} onOpenChange={setIosOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Pasang di iPhone atau iPad</DialogTitle>
              <DialogDescription>
                Safari tidak memiliki tombol instal otomatis. Ikuti langkah berikut.
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-3 text-sm">
              <li className="flex items-center gap-3">
                <Share className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span>Ketuk tombol Bagikan di bilah Safari.</span>
              </li>
              <li className="flex items-center gap-3">
                <SquarePlus className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span>Pilih Tambah ke Layar Utama, lalu ketuk Tambah.</span>
              </li>
            </ol>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return null
}
