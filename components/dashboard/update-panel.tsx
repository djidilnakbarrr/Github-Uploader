"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { CheckCircle2, FileArchive, FileCode2, FolderUp, Loader2, RefreshCcw } from "lucide-react"
import { useGithub } from "@/lib/github-context"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  type SourceFile,
  applyPlan,
  buildPlan,
  sourceFromFolder,
  sourceFromHtml,
  sourceFromZip,
} from "@/lib/update-support"

interface Result {
  label: string
  added: number
  modified: number
  removed: number
  unchanged: number
}

export function UpdatePanel() {
  const { config, owner, isConfigured, recordUploads } = useGithub()
  const folderRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const htmlRef = useRef<HTMLInputElement>(null)
  const runningRef = useRef(false)
  const [stage, setStage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  const busy = stage !== null

  // Satu langkah otomatis: baca sumber, bandingkan, ganti file baru, hapus file lama, commit.
  const run = async (label: string, load: () => Promise<SourceFile[]>) => {
    if (runningRef.current) return
    if (!isConfigured) return toast.error("Pilih repositori tujuan terlebih dahulu")
    runningRef.current = true
    setResult(null)
    setProgress(null)
    try {
      const ref = { owner, repo: config.repo.trim(), branch: config.branch.trim(), token: config.token }
      setStage("Membaca file...")
      const source = await load()
      if (source.length === 0) throw new Error("Tidak ada file yang bisa dibaca dari pilihan Anda")

      setStage("Membandingkan dengan repositori...")
      const plan = await buildPlan(ref, source)

      const changes = plan.added.length + plan.modified.length + plan.removed.length
      if (changes === 0) {
        setResult({ label, added: 0, modified: 0, removed: 0, unchanged: plan.unchanged.length })
        toast.info("Repositori sudah sama dengan versi yang dipilih")
        return
      }

      setStage("Mengganti file dan menghapus file lama...")
      setProgress(0)
      await applyPlan(ref, plan, (d, t) => setProgress(t ? (d / t) * 100 : 100))

      const n = plan.added.length + plan.modified.length
      if (n > 0) recordUploads(n)
      setResult({
        label,
        added: plan.added.length,
        modified: plan.modified.length,
        removed: plan.removed.length,
        unchanged: plan.unchanged.length,
      })
      toast.success("Pembaruan selesai")
    } catch (err: any) {
      toast.error(`Pembaruan gagal: ${err?.message || "kesalahan tidak dikenal"}. Repositori tidak diubah.`)
    } finally {
      runningRef.current = false
      setStage(null)
      setProgress(null)
    }
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>, kind: "folder" | "zip" | "html") => {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = ""
    if (files.length === 0) return
    if (kind === "folder") void run(`Folder (${files.length} file)`, async () => sourceFromFolder(files))
    if (kind === "zip") void run(files[0].name, () => sourceFromZip(files[0]))
    if (kind === "html")
      void run(files.length === 1 ? files[0].name : `${files.length} file HTML`, async () => sourceFromHtml(files))
  }

  const disabled = busy || !isConfigured

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <RefreshCcw className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Perbarui proyek</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Pilih versi terbaru proyek Anda. Semua file lama otomatis dihapus dan diganti dengan file baru dalam
              satu commit.
            </p>
          </div>
        </div>

        <input ref={folderRef} type="file" className="hidden" multiple {...({ webkitdirectory: "true", directory: "true" } as any)} onChange={(e) => pick(e, "folder")} />
        <input ref={zipRef} type="file" accept=".zip" className="hidden" onChange={(e) => pick(e, "zip")} />
        <input ref={htmlRef} type="file" accept=".html,.htm" multiple className="hidden" onChange={(e) => pick(e, "html")} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Button variant="outline" className="h-12 w-full gap-2" disabled={disabled} onClick={() => folderRef.current?.click()}>
            <FolderUp className="h-4 w-4" /> Pilih Folder
          </Button>
          <Button variant="outline" className="h-12 w-full gap-2" disabled={disabled} onClick={() => zipRef.current?.click()}>
            <FileArchive className="h-4 w-4" /> Ekstrak & Unggah ZIP
          </Button>
          <Button variant="outline" className="h-12 w-full gap-2" disabled={disabled} onClick={() => htmlRef.current?.click()}>
            <FileCode2 className="h-4 w-4" /> Pilih HTML
          </Button>
        </div>

        {!isConfigured && <p className="text-xs text-muted-foreground">Pilih repositori tujuan terlebih dahulu.</p>}

        {busy && (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" /> {stage}
            </p>
            {progress !== null && <Progress value={progress} />}
            <p className="text-xs text-muted-foreground">Jangan tutup halaman ini sampai selesai.</p>
          </div>
        )}

        {result && !busy && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              {result.added + result.modified + result.removed === 0 ? "Sudah terbaru" : "Pembaruan selesai"}
            </p>
            <p className="break-all text-xs text-muted-foreground">{result.label}</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["Baru", result.added],
                ["Diganti", result.modified],
                ["Dihapus", result.removed],
              ].map(([t, n]) => (
                <div key={t as string} className="rounded-md border bg-background px-2 py-2">
                  <p className="text-base font-semibold leading-none">{n}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t}</p>
                </div>
              ))}
            </div>
            {result.unchanged > 0 && (
              <p className="text-xs text-muted-foreground">{result.unchanged} file tidak berubah dan dilewati.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
