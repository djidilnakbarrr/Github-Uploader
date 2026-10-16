"use client"

import { useState, useEffect } from "react"
import { useGithub } from "@/lib/github-context"
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { Folder, File, ArrowUpLeft, RefreshCw, Trash2, Search, Loader2, AlertTriangle } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { encodeRepoPath } from "@/lib/utils"

export function Explorer() {
  const { config, owner, isConfigured } = useGithub()
  const [files, setFiles] = useState<any[]>([])
  const [currentPath, setCurrentPath] = useState("")
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)

  const fetchFiles = async (path: string = "") => {
    if (!isConfigured) return
    setLoading(true)
    try {
      const repo = config.repo.trim()
      const branch = config.branch.trim()

      const encoded = encodeRepoPath(path)
      const apiPath = encoded ? `/${encoded}` : ""
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${apiPath}?ref=${encodeURIComponent(branch)}`
      
      const res = await fetch(apiUrl, {
        headers: { 
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github.v3+json"
        },
        cache: 'no-store'
      })
      if (!res.ok) {
        if (res.status === 404) {
          setFiles([])
          setCurrentPath(path)
          return
        }
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.message || "Gagal mengambil file")
      }
      
      let data = await res.json()
      if (!Array.isArray(data)) data = [data]
      
      // Sort: folders first, then files
      data.sort((a: any, b: any) => {
        if (a.type === b.type) return a.name.localeCompare(b.name)
        return a.type === "dir" ? -1 : 1
      })
      
      setFiles(data)
      setCurrentPath(path)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isConfigured) {
      setCurrentPath("")
      fetchFiles("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigured, owner, config.repo, config.branch, config.token])

  const navigateTo = (path: string) => {
    fetchFiles(path)
  }

  const navigateUp = () => {
    if (!currentPath) return
    const parts = currentPath.split("/").filter(Boolean)
    parts.pop()
    fetchFiles(parts.join("/"))
  }

  const handleDelete = async (file: any) => {
    if (!confirm(`Apakah Anda yakin ingin menghapus ${file.name}?`)) return
    
    try {
      const repo = config.repo.trim()
      const branch = config.branch.trim()
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepoPath(file.path)}`
      
      const res = await fetch(apiUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `Hapus ${file.name}`,
          sha: file.sha,
          branch
        })
      })
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData?.message ? `Gagal menghapus: ${errData.message}` : "Gagal menghapus")
      }
      toast.success("Berhasil dihapus")
      fetchFiles(currentPath)
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  // Hapus semua file di folder yang sedang dibuka (termasuk subfolder) dalam SATU commit.
  const handleDeleteAll = async () => {
    setDeletingAll(true)
    try {
      const repo = config.repo.trim()
      const branch = config.branch.trim()
      const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      const headers = {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      }
      const call = async (url: string, init?: RequestInit) => {
        const res = await fetch(url, { ...init, headers, cache: "no-store" })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.message || `Permintaan gagal (${res.status})`)
        return data
      }

      const ref = await call(`${base}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`)
      const headSha: string = ref.object.sha
      const headCommit = await call(`${base}/git/commits/${headSha}`)
      const tree = await call(`${base}/git/trees/${headCommit.tree.sha}?recursive=1`)
      if (tree.truncated) throw new Error("Repositori terlalu besar untuk dihapus sekaligus")

      const prefix = currentPath ? `${currentPath}/` : ""
      const targets = (tree.tree as any[]).filter(
        (n) => n.type === "blob" && (!prefix || n.path.startsWith(prefix))
      )
      if (targets.length === 0) {
        toast.info("Tidak ada file untuk dihapus")
        setConfirmAllOpen(false)
        return
      }

      const newTree = await call(`${base}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: headCommit.tree.sha,
          tree: targets.map((n) => ({ path: n.path, mode: n.mode, type: "blob", sha: null })),
        }),
      })
      const commit = await call(`${base}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: currentPath ? `Hapus semua file di ${currentPath}` : "Hapus semua file",
          tree: newTree.sha,
          parents: [headSha],
        }),
      })
      await call(`${base}/git/refs/heads/${encodeURIComponent(branch).replace(/%2F/g, "/")}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
      })

      toast.success(`${targets.length} file berhasil dihapus`)
      setConfirmAllOpen(false)
      // Jika folder sekarang kosong, GitHub menghilangkannya: naik ke induk yang masih ada
      await fetchFiles(currentPath)
    } catch (err: any) {
      toast.error(`Gagal menghapus semua: ${err.message}`)
    } finally {
      setDeletingAll(false)
    }
  }

  const filteredFiles = files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()))

  if (!isConfigured) {
    return (
      <Card className="bg-destructive/10 border-destructive mt-6 max-w-5xl mx-auto">
        <CardContent className="p-4 text-center">
          Harap konfigurasikan pengaturan GitHub Anda untuk menjelajahi file.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={navigateUp} disabled={!currentPath || loading} className="h-10 w-10 flex-shrink-0" aria-label="Naik satu folder">
            <ArrowUpLeft className="h-4 w-4" />
          </Button>
          <div className="h-10 min-w-0 flex-1 truncate rounded-md bg-muted px-3 font-mono text-sm leading-10">
            {config.repo} / {currentPath || "<root>"}
          </div>
          <Button variant="ghost" size="icon" onClick={() => fetchFiles(currentPath)} disabled={loading} className="h-10 w-10 flex-shrink-0" aria-label="Muat ulang">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Cari file..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 w-full pl-9"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => setConfirmAllOpen(true)}
            disabled={loading || files.length === 0}
            className="h-10 gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Hapus Semua
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-t overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[860px] text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="min-w-[18rem] px-6 py-4 font-medium whitespace-nowrap">Nama</th>
                <th className="min-w-[8rem] px-6 py-4 font-medium whitespace-nowrap">Tipe</th>
                <th className="min-w-[9rem] px-6 py-4 font-medium whitespace-nowrap">Ukuran</th>
                <th className="min-w-[7rem] px-6 py-4 text-right font-medium whitespace-nowrap">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-muted-foreground">Memuat...</td></tr>
              ) : filteredFiles.length === 0 ? (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-muted-foreground">Tidak ada file ditemukan</td></tr>
              ) : (
                filteredFiles.map((file) => (
                  <tr key={file.sha || file.path} className="hover:bg-muted/50 transition-colors">
                    <td className="min-w-[18rem] px-6 py-4">
                      <div className="flex items-center gap-2">
                        {file.type === "dir" ? <Folder className="h-4 w-4 text-primary" /> : <File className="h-4 w-4 text-muted-foreground" />}
                        {file.type === "dir" ? (
                          <button onClick={() => navigateTo(file.path)} className="whitespace-nowrap text-left font-medium hover:underline">
                            {file.name}
                          </button>
                        ) : (
                          <a href={file.download_url} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:underline">
                            {file.name}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-muted-foreground">{file.type === "dir" ? "Dir" : "File"}</td>
                    <td className="whitespace-nowrap px-6 py-4 text-muted-foreground">
                      {file.type === "file" ? (file.size > 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${file.size} B`) : "--"}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {file.type === "file" && (
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => handleDelete(file)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
      <Dialog open={confirmAllOpen} onOpenChange={(o) => !deletingAll && setConfirmAllOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <DialogTitle>Hapus semua file?</DialogTitle>
            <DialogDescription>
              Semua file di <span className="font-mono font-medium text-foreground">{config.repo} / {currentPath || "<root>"}</span>{" "}
              beserta isi subfolder-nya akan dihapus dari cabang{" "}
              <span className="font-medium text-foreground">{config.branch}</span> dalam satu commit. Tindakan ini tidak dapat dibatalkan dari aplikasi.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmAllOpen(false)} disabled={deletingAll}>
              Batal
            </Button>
            <Button variant="destructive" onClick={handleDeleteAll} disabled={deletingAll}>
              {deletingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {deletingAll ? "Menghapus..." : "Ya, hapus semua"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
