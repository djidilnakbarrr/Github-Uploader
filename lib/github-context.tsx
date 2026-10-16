"use client"
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { get, set } from 'idb-keyval'

export interface GitHubConfig {
  token: string
  username: string
  repo: string
  branch: string
  targetFolder: string
  commitMessageTemplate: string
}

export interface UploadHistory {
  [date: string]: number
}

export interface GithubContextType {
  config: GitHubConfig
  setConfig: (config: GitHubConfig) => void
  user: any
  /** Effective repo owner: configured username, or the authenticated user's login. */
  owner: string
  repositories: any[]
  branches: string[]
  isConfigured: boolean
  fetchRepositories: () => void
  uploadHistory: UploadHistory
  recordUploads: (count: number) => void
}

const defaultConfig: GitHubConfig = {
  token: '',
  username: '',
  repo: '',
  branch: 'main',
  targetFolder: '',
  commitMessageTemplate: 'Upload {filename}'
}

const GithubContext = createContext<GithubContextType | undefined>(undefined)

export function GithubProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfigState] = useState<GitHubConfig>(defaultConfig)
  const [user, setUser] = useState<any>(null)
  const [repositories, setRepositories] = useState<any[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [uploadHistory, setUploadHistory] = useState<UploadHistory>({})

  useEffect(() => {
    const loadData = async () => {
      try {
        const savedConfig = await get('github-uploader-config')
        if (savedConfig && typeof savedConfig === 'object') {
          setConfigState({ ...defaultConfig, ...savedConfig, targetFolder: '' })
        }

        const savedHistory = await get('github-upload-history')
        if (savedHistory && typeof savedHistory === 'object') {
          setUploadHistory(savedHistory)
        }
      } catch (e) {
        console.error("Failed to load data from IndexedDB", e)
      }
    }
    loadData()
  }, [])

  const setConfig = useCallback(async (newConfig: GitHubConfig) => {
    const cleaned: GitHubConfig = {
      ...newConfig,
      token: newConfig.token.trim(),
      username: newConfig.username.trim(),
      repo: newConfig.repo.trim(),
      branch: newConfig.branch.trim() || 'main',
      targetFolder: '',
    }
    setConfigState(cleaned)
    try {
      await set('github-uploader-config', cleaned)
    } catch (e) {
      console.error("Failed to save config to IndexedDB", e)
    }
  }, [])

  const recordUploads = useCallback((count: number) => {
    if (count <= 0) return
    const date = new Date().toISOString().split('T')[0]
    setUploadHistory(prev => {
      const newHistory = { ...prev, [date]: (prev[date] || 0) + count }
      set('github-upload-history', newHistory).catch(e => console.error("Failed to save history", e))
      return newHistory
    })
  }, [])

  // Authenticated user
  useEffect(() => {
    if (!config.token) {
      setUser(null)
      return
    }
    let cancelled = false
    fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: 'no-store'
    })
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (!cancelled) setUser(data && data.login ? data : null) })
      .catch(() => { if (!cancelled) setUser(null) })
    return () => { cancelled = true }
  }, [config.token])

  const owner = (config.username || user?.login || '').trim()

  const fetchRepositories = useCallback(() => {
    if (!config.token || !owner) {
      setRepositories([])
      return
    }
    // For the authenticated user use /user/repos so private repos are included.
    const isSelf = user?.login && owner.toLowerCase() === String(user.login).toLowerCase()
    const url = isSelf
      ? 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner'
      : `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`
    fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: 'no-store'
    })
      .then(res => res.json())
      .then(data => {
        setRepositories(Array.isArray(data) ? data : [])
      })
      .catch(() => setRepositories([]))
  }, [config.token, owner, user?.login])

  useEffect(() => {
    fetchRepositories()
  }, [fetchRepositories])

  // Branches of the selected repo
  useEffect(() => {
    const repo = config.repo.trim()
    if (!config.token || !repo || !owner) {
      setBranches([])
      return
    }
    let cancelled = false
    fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: 'no-store'
    })
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        setBranches(Array.isArray(data) ? data.map((b: any) => b.name) : [])
      })
      .catch(() => { if (!cancelled) setBranches([]) })
    return () => { cancelled = true }
  }, [config.token, config.repo, owner])

  const isConfigured = Boolean(config.token && owner && config.repo && config.branch)

  const value = useMemo<GithubContextType>(() => ({
    config, setConfig, user, owner, repositories, branches, isConfigured,
    fetchRepositories, uploadHistory, recordUploads
  }), [config, setConfig, user, owner, repositories, branches, isConfigured, fetchRepositories, uploadHistory, recordUploads])

  return (
    <GithubContext.Provider value={value}>
      {children}
    </GithubContext.Provider>
  )
}

export function useGithub() {
  const context = useContext(GithubContext)
  if (!context) throw new Error("useGithub must be used within GithubProvider")
  return context
}
