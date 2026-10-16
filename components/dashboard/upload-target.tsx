"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { BookMarked, Check, ChevronsUpDown, GitBranch, Globe, Lock, RefreshCw, Search } from "lucide-react"
import { useGithub } from "@/lib/github-context"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function UploadTarget({ disabled = false }: { disabled?: boolean }) {
  const { config, setConfig, owner, repositories, branches, fetchRepositories } = useGithub()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [repoInput, setRepoInput] = useState(config.repo)

  useEffect(() => {
    setRepoInput(config.repo)
  }, [config.repo])

  const selectRepo = (name: string) => {
    if (name !== config.repo) {
      const found = repositories.find((r) => r.name === name)
      const branch = (found && found.default_branch) || "main"
      setConfig({ ...config, repo: name, branch })
    }
    setPickerOpen(false)
    setQuery("")
  }

  const commitRepoInput = () => {
    const name = repoInput.trim()
    if (name !== config.repo) setConfig({ ...config, repo: name })
  }

  const selectBranch = (name: string) => {
    if (name && name !== config.branch) setConfig({ ...config, branch: name })
  }

  const branchOptions =
    !config.branch || branches.includes(config.branch) ? branches : [config.branch, ...branches]

  const q = query.trim().toLowerCase()
  const filtered = repositories.filter((r) => String(r.name).toLowerCase().includes(q))
  const selected = repositories.find((r) => r.name === config.repo)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold tracking-tight">Tujuan unggahan</h3>
        <span className="max-w-[55%] truncate rounded-full border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          @{owner}
        </span>
      </div>

      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="target-repo" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Repositori
            </Label>
            {repositories.length > 0 ? (
              <button
                id="target-repo"
                type="button"
                disabled={disabled}
                onClick={() => setPickerOpen(true)}
                className="group flex h-14 w-full items-center gap-3 rounded-lg border bg-background px-3 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {selected?.private ? <Lock className="h-4 w-4" /> : <BookMarked className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-medium ${config.repo ? "" : "text-muted-foreground"}`}>
                    {config.repo || "Pilih repositori"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {config.repo ? (selected?.private ? "Privat" : "Publik") : `${repositories.length} repositori tersedia`}
                  </span>
                </span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              </button>
            ) : (
              <Input
                id="target-repo"
                value={repoInput}
                disabled={disabled}
                onChange={(e) => setRepoInput(e.target.value)}
                onBlur={commitRepoInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRepoInput()
                }}
                placeholder="nama-repositori"
                className="h-14"
              />
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="target-branch" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Cabang (Branch)
            </Label>
            {branchOptions.length > 0 ? (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <GitBranch className="h-4 w-4" />
                </span>
                <Select value={config.branch} onValueChange={selectBranch} disabled={disabled}>
                  <SelectTrigger id="target-branch" className="h-14 rounded-lg pl-14 pr-3 text-sm font-medium shadow-sm transition-all hover:border-primary/50 hover:shadow">
                    <SelectValue placeholder="Pilih cabang" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchOptions.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <Input id="target-branch" value={config.branch} disabled className="h-14" aria-label="Cabang" />
            )}
          </div>
        </div>

        {config.repo ? (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <p className="min-w-0 break-words">
              File akan diunggah ke{" "}
              <span className="font-semibold text-foreground">{owner}/{config.repo}</span>{" "}
              pada cabang <span className="font-semibold text-foreground">{config.branch}</span>.
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2.5 text-xs text-foreground">
            Pilih repositori tujuan terlebih dahulu sebelum mengunggah.
          </p>
        )}

        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent className="max-w-md gap-0 p-0">
            <DialogHeader className="border-b p-5 pr-12">
              <DialogTitle>Pilih repositori</DialogTitle>
              <DialogDescription>{repositories.length} repositori ditemukan untuk @{owner}.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 border-b p-4">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Cari repositori..."
                  aria-label="Cari repositori"
                  className="h-11 pl-9"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                title="Muat ulang daftar"
                aria-label="Muat ulang daftar repositori"
                onClick={() => {
                  fetchRepositories()
                  toast.info("Memuat ulang daftar repositori")
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Tidak ada repositori yang cocok.</p>
              ) : (
                <ul className="space-y-1">
                  {filtered.map((r) => {
                    const active = r.name === config.repo
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => selectRepo(r.name)}
                          className={`flex min-h-[56px] w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            active ? "bg-primary/10" : ""
                          }`}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                            {r.private ? <Lock className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{r.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {r.private ? "Privat" : "Publik"}
                              {r.description ? `, ${r.description}` : ""}
                            </span>
                          </span>
                          {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
