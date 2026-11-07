export interface Marker {
  start: number
  end: number
  confidence: number
  source: 'match' | 'series' | 'manual'
}

export interface Episode {
  id: string
  file: string
  name: string
  duration: number
  hasAudio?: boolean
  op: Marker | null
  ed: Marker | null
  analyzedAt: string | null
}

export interface Series {
  id: string
  title: string
  folder: string
  createdAt: string
  episodes: Episode[]
}

export interface Library {
  series: Series[]
}

export interface AnalyzeProgress {
  phase: 'extract' | 'match'
  index: number
  total: number
  file?: string
  kind?: 'op' | 'ed'
}

export interface AnalyzeResult {
  episodes: Array<{
    file: string
    duration: number
    op: { start: number; end: number; confidence: number; source: string } | null
    ed: { start: number; end: number; confidence: number; source: string } | null
  }>
  opSeries: { start: number; end: number; confidence: number; votes: number } | null
  edSeries: { start: number; end: number; confidence: number; votes: number } | null
}

export interface OpEdBridge {
  loadLibrary: () => Promise<Library>
  saveLibrary: (library: Library) => Promise<boolean>
  addSeries: () => Promise<{ series: Series } | { error: string } | null>
  addFiles: (seriesId: string) => Promise<{ seriesId: string; episodes: Episode[] } | null>
  analyze: (files: string[]) => Promise<AnalyzeResult>
  prepareMedia: (file: string) => Promise<{ path: string }>
  reveal: (file: string) => Promise<void>
  cacheInfo: () => Promise<{ dir: string; size: number }>
  clearCache: () => Promise<boolean>
  onAnalyzeProgress: (callback: (progress: AnalyzeProgress) => void) => () => void
  mediaUrl: (file: string) => string
  runBatch: (args?: string[]) => Promise<{ ok: boolean; log: string }>
  onBatchLog: (callback: (text: string) => void) => () => void
}

declare global {
  interface Window {
    oped: OpEdBridge
  }
}
