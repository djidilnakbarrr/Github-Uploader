"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { useDropzone } from "react-dropzone"
import { useGithub } from "@/lib/github-context"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { UploadCloud, FolderUp, FileArchive, X } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { UploadTarget } from "@/components/dashboard/upload-target"
import { UpdatePanel } from "@/components/dashboard/update-panel"
import JSZip from "jszip"
import {
  type QueueItem,
  UPLOAD_GAP_MS,
  clearDone,
  createItem,
  createWakeLock,
  loadQueue,
  markDone,
  notifyIfHidden,
  requestNotificationPermission,
  saveQueue,
  sleep,
  uploadFileWithRetry,
  withUploadLock,
} from "@/lib/upload-support"

export function Uploader() {
  const { config, owner, isConfigured, recordUploads } = useGithub()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [mode, setMode] = useState<"upload" | "update">("upload")
  const folderInputRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)
  const persistWarned = useRef(false)
  const startRef = useRef<() => void>(() => {})

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const items = acceptedFiles.map(createItem)
    setQueue(prev => [...prev, ...items])
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop })

  // Pulihkan antrean dari sesi sebelumnya (mis. tab tertutup saat mengunggah)
  useEffect(() => {
    let cancelled = false
    loadQueue()
      .then(items => {
        if (cancelled || items.length === 0) return
        setQueue(prev => [...items, ...prev])
        toast.info(`${items.length} file dari sesi sebelumnya dipulihkan`, {
          id: "queue-restored",
          duration: 15000,
          action: { label: "Lanjutkan", onClick: () => startRef.current() },
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Simpan antrean setiap berubah
  useEffect(() => {
    if (!hydrated) return
    saveQueue(queue)
      .then(() => (uploadingRef.current ? undefined : clearDone()))
      .catch(() => {
        if (persistWarned.current) return
        persistWarned.current = true
        toast.warning("Antrean tidak dapat disimpan untuk pemulihan (penyimpanan perangkat penuh?)")
      })
  }, [queue, hydrated])

  // Peringatkan jika tab ditutup saat unggahan berjalan
  useEffect(() => {
    ;(window as any).__appBusy = isUploading
    if (!isUploading) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => {
      window.removeEventListener("beforeunload", handler)
      ;(window as any).__appBusy = false
    }
  }, [isUploading])

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = ""
    if (files.length === 0) return
    const items = files.map(createItem)
    setQueue(prev => [...prev, ...items])
  }

  const handleZipExtract = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    toast.info("Mengekstrak file ZIP...")
    try {
      const zip = new JSZip()
      const contents = await zip.loadAsync(file)
      const extractedFiles: File[] = []
      
      const validEntries = (Object.entries(contents.files) as [string, JSZip.JSZipObject][]).filter(
        ([name]) => !name.startsWith('__MACOSX/') && !name.includes('/.DS_Store') && !name.endsWith('.DS_Store')
      );

      let rootFolder = null;
      let isSingleRoot = true;
      
      for (const [filename, entry] of validEntries) {
        if (entry.dir) continue;
        const parts = filename.split('/');
        if (parts.length === 1) {
           isSingleRoot = false;
           break;
        }
        if (parts.length > 1) {
           if (rootFolder === null) {
              rootFolder = parts[0];
           } else if (rootFolder !== parts[0]) {
              isSingleRoot = false;
              break;
           }
        }
      }

      const prefixToRemove = isSingleRoot && rootFolder ? `${rootFolder}/` : "";

      for (const [filename, zipEntry] of validEntries) {
        if (!zipEntry.dir) {
          const blob = await zipEntry.async("blob")
          let finalName = filename;
          if (prefixToRemove && finalName.startsWith(prefixToRemove)) {
             finalName = finalName.substring(prefixToRemove.length);
          }
          const extractedFile = new File([blob], finalName)
          Object.defineProperty(extractedFile, 'webkitRelativePath', { value: finalName });
          extractedFiles.push(extractedFile)
        }
      }
      const items = extractedFiles.map(createItem)
      setQueue(prev => [...prev, ...items])
      toast.success(`Berhasil mengekstrak ${extractedFiles.length} file`)
    } catch (err) {
      toast.error("Gagal mengekstrak ZIP")
    }
  }

  const removeFile = (index: number) => {
    setQueue(prev => prev.filter((_, i) => i !== index))
  }

  const clearQueue = () => setQueue([])

  const startUpload = async () => {
    if (uploadingRef.current) return
    if (!config.token || !owner) return toast.error("Harap konfigurasikan pengaturan GitHub terlebih dahulu")
    if (!isConfigured) return toast.error("Pilih repositori tujuan terlebih dahulu")
    if (queue.length === 0) return toast.error("Tidak ada file dalam antrean")

    uploadingRef.current = true
    setIsUploading(true)
    setProgress(0)
    requestNotificationPermission()

    const items = queue
    const total = items.length
    const target = {
      owner,
      repo: config.repo.trim(),
      branch: config.branch.trim(),
      token: config.token,
      targetFolder: config.targetFolder,
      commitMessageTemplate: config.commitMessageTemplate,
    }
    const processed = new Set<string>()
    const failedIds = new Set<string>()
    let uploadedCount = 0
    const wakeLock = createWakeLock()
    wakeLock.start()

    try {
      const ran = await withUploadLock(async () => {
        for (let i = 0; i < total; i++) {
          const item = items[i]
          try {
            await uploadFileWithRetry(item, target, (msg) => toast.info(msg, { id: "upload-wait" }))
            uploadedCount++
            markDone(item.id).catch(() => {})
          } catch (err: any) {
            failedIds.add(item.id)
            toast.error(err?.message || `Gagal mengunggah ${item.file.name}`)
          }
          processed.add(item.id)
          setProgress(((i + 1) / total) * 100)
          // Beri jeda antar file agar tidak terkena pembatasan GitHub
          if (i < total - 1) await sleep(UPLOAD_GAP_MS)
        }
      })

      if (!ran) {
        toast.error("Unggahan lain sedang berjalan di tab atau jendela lain")
      } else {
        if (uploadedCount > 0) {
          toast.success(`Berhasil mengunggah ${uploadedCount} file`)
          recordUploads(uploadedCount)
        }
        const failedCount = failedIds.size
        const summary =
          failedCount > 0
            ? `${uploadedCount} file berhasil, ${failedCount} gagal`
            : `${uploadedCount} file berhasil diunggah`
        void notifyIfHidden("Unggahan selesai", summary)
      }
    } catch (err: any) {
      toast.error(err?.message || "Unggahan terhenti karena kesalahan tak terduga")
    } finally {
      wakeLock.stop()
      uploadingRef.current = false
      // Pertahankan file yang gagal dan file yang ditambahkan selama unggahan berjalan
      setQueue(prev => prev.filter(it => !processed.has(it.id) || failedIds.has(it.id)))
      setIsUploading(false)
      setProgress(0)
    }
  }

  useEffect(() => {
    startRef.current = () => {
      void startUpload()
    }
  })

  return (
    <div className="space-y-6 max-w-4xl mx-auto mt-6">
      {!(config.token && owner) && (
        <Card className="bg-destructive/10 border-destructive">
          <CardContent className="p-4 text-center">
            Harap konfigurasikan pengaturan GitHub Anda di tab Pengaturan sebelum mengunggah.
          </CardContent>
        </Card>
      )}

      {config.token && owner && <UploadTarget disabled={isUploading} />}

      {config.token && owner && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Mode unggah">
          {([["upload", "Unggah Biasa"], ["update", "Perbarui"]] as const).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              disabled={isUploading}
              onClick={() => setMode(value)}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-all disabled:opacity-60 ${
                mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      )}

      {mode === "update" && config.token && owner && <UpdatePanel />}

      <div className={mode === "upload" ? "space-y-6" : "hidden"}>
      <div className="flex gap-4">
        <div
          {...getRootProps()}
          className={`min-w-0 flex-1 border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-colors ${isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"}`}
        >
          <input {...getInputProps()} />
          <UploadCloud className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-base font-medium sm:text-lg">Seret & lepas file ke sini, atau klik untuk memilih</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="w-full min-w-0">
          <input 
            type="file" 
            ref={folderInputRef} 
            className="hidden" 
            {...({ webkitdirectory: "true", directory: "true" } as any)}
            multiple 
            onChange={handleFolderSelect} 
          />
          <Button variant="outline" className="h-12 w-full" onClick={() => folderInputRef.current?.click()}>
            <FolderUp className="mr-2 h-4 w-4" /> Pilih Folder
          </Button>
        </div>
        <div className="w-full min-w-0">
          <input 
            type="file" 
            id="zipExtract"
            className="hidden" 
            accept=".zip"
            onChange={handleZipExtract} 
          />
          <Button variant="outline" className="h-12 w-full" onClick={() => document.getElementById("zipExtract")?.click()}>
            <FileArchive className="mr-2 h-4 w-4" /> Ekstrak & Unggah ZIP
          </Button>
        </div>
      </div>

      {queue.length > 0 && (
        <Card>
          <CardHeader className="flex flex-col items-start justify-between gap-4 p-4 sm:flex-row sm:items-center sm:p-6">
            <div>
              <CardTitle>Antrean Unggahan</CardTitle>
              <CardDescription>{queue.length} file dalam antrean</CardDescription>
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <Button variant="outline" className="flex-1 sm:flex-none" onClick={clearQueue} disabled={isUploading}>Bersihkan</Button>
              <Button onClick={startUpload} className="flex-1 sm:flex-none" disabled={isUploading}>
                {isUploading ? "Mengunggah..." : "Mulai Unggah"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-4 pt-0 sm:p-6 sm:pt-0">
            {isUploading && <Progress value={progress} />}
            <div className="max-h-64 overflow-y-auto border rounded-md">
              {queue.map((item, i) => (
                <div key={item.id} className="flex items-center justify-between p-3 border-b last:border-0 hover:bg-muted/50">
                  <div className="truncate flex-1 mr-4">
                    <p className="text-sm font-medium truncate">{item.file.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.file.webkitRelativePath || "Root"}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="shrink-0" onClick={() => removeFile(i)} disabled={isUploading}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  )
}
