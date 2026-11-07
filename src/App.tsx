import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Player, { formatTime, type PlayerSettings } from './Player'
import BatchPanel from './BatchPanel'
import HistoryPanel from './HistoryPanel'
import type { AnalyzeProgress, Library, Marker, Series } from './types'

const SETTINGS_KEY = 'oped-finder:settings'

function loadSettings(): PlayerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { autoSkipOp: false, autoSkipEd: false, autoAdvance: true, ...JSON.parse(raw) }
  } catch { /* ignora */ }
  return { autoSkipOp: false, autoSkipEd: false, autoAdvance: true }
}

export default function App() {
  const [library, setLibrary] = useState<Library>({ series: [] })
  const [loaded, setLoaded] = useState(false)
  const [seriesId, setSeriesId] = useState<string | null>(null)
  const [episodeId, setEpisodeId] = useState<string | null>(null)
  const [settings, setSettings] = useState<PlayerSettings>(loadSettings)
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'info' | 'error'; text: string } | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; text: string } | null>(null)
  const [batchLogs, setBatchLogs] = useState<string[]>([])
  const [batchVisible, setBatchVisible] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const saveTimer = useRef<number | null>(null)

  useEffect(() => {
    window.oped.loadLibrary()
      .then((data) => {
        setLibrary(data)
        const first = data.series[0]
        if (first) {
          setSeriesId(first.id)
          setEpisodeId(first.episodes[0]?.id ?? null)
        }
      })
      .catch((error: Error) => setToast({ type: 'error', text: error.message }))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!loaded) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.oped.saveLibrary(library)
    }, 350)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [library, loaded])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    const unsubscribe = window.oped.onAnalyzeProgress((payload) => setProgress(payload))
    return unsubscribe
  }, [])

  // progresso do batch em tempo real
  useEffect(() => {
    const unsubLog = window.oped.onBatchLog((text) => {
      const m = text.match(/^PROGRESS:(\d+)\/(\d+)/)
      if (m) {
        setBatchProgress({ current: +m[1], total: +m[2], text: text.replace(/^PROGRESS:\d+\/\d+\s*/, '') })
        setBatchVisible(true)
      } else {
        setBatchLogs((prev) => [...prev, text])
      }
    })
    return unsubLog
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const series = useMemo(() => library.series.find((item) => item.id === seriesId) ?? null, [library, seriesId])
  const episode = useMemo(
    () => series?.episodes.find((item) => item.id === episodeId) ?? null,
    [series, episodeId],
  )
  const episodeIndex = series && episode ? series.episodes.findIndex((item) => item.id === episode.id) : -1
  const nextEpisode = series && episodeIndex >= 0 ? series.episodes[episodeIndex + 1] ?? null : null

  const updateSeries = useCallback((id: string, updater: (series: Series) => Series) => {
    setLibrary((current) => ({
      ...current,
      series: current.series.map((item) => (item.id === id ? updater(item) : item)),
    }))
  }, [])

  const addSeries = async () => {
    setBusy('Lendo pasta…')
    try {
      const result = await window.oped.addSeries()
      if (!result) return
      if ('error' in result) {
        setToast({ type: 'error', text: result.error })
        return
      }
      setLibrary((current) => ({ series: [...current.series, result.series] }))
      setSeriesId(result.series.id)
      setEpisodeId(result.series.episodes[0]?.id ?? null)
      setToast({ type: 'info', text: `${result.series.episodes.length} episódio(s) adicionados.` })
    } catch (error) {
      setToast({ type: 'error', text: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const addEpisodes = async () => {
    if (!series) return
    setBusy('Lendo arquivos…')
    try {
      const result = await window.oped.addFiles(series.id)
      if (!result) return
      updateSeries(series.id, (current) => {
        const known = new Set(current.episodes.map((item) => item.file))
        const fresh = result.episodes.filter((item) => !known.has(item.file))
        const episodes = [...current.episodes, ...fresh].sort((a, b) =>
          a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }),
        )
        return { ...current, episodes }
      })
      setToast({ type: 'info', text: `${result.episodes.length} episódio(s) adicionados.` })
    } catch (error) {
      setToast({ type: 'error', text: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const analyze = async () => {
    if (!series) return
    if (series.episodes.length < 2) {
      setToast({ type: 'error', text: 'Adicione pelo menos 2 episódios para comparar o áudio e achar o OP/ED.' })
      return
    }
    setBusy('Analisando áudio…')
    setProgress(null)
    try {
      const result = await window.oped.analyze(series.episodes.map((item) => item.file))
      const byFile = new Map(result.episodes.map((item) => [item.file, item]))
      const stamp = new Date().toISOString()
      updateSeries(series.id, (current) => ({
        ...current,
        episodes: current.episodes.map((item) => {
          const found = byFile.get(item.file)
          if (!found) return item
          return {
            ...item,
            op: found.op ? { ...found.op, source: found.op.source === 'series' ? 'series' : 'match' } : item.op,
            ed: found.ed ? { ...found.ed, source: found.ed.source === 'series' ? 'series' : 'match' } : item.ed,
            analyzedAt: stamp,
          }
        }),
      }))
      const foundOp = result.episodes.filter((item) => item.op).length
      const foundEd = result.episodes.filter((item) => item.ed).length
      setToast({
        type: foundOp ? 'info' : 'error',
        text: foundOp
          ? `OP encontrado em ${foundOp} episódio(s) e ED em ${foundEd}.`
          : 'Não encontrei trecho repetido. Sem abertura? Marque manualmente no player.',
      })
    } catch (error) {
      setToast({ type: 'error', text: (error as Error).message })
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const updateMarker = (kind: 'op' | 'ed', marker: Marker | null) => {
    if (!series || !episode) return
    updateSeries(series.id, (current) => ({
      ...current,
      episodes: current.episodes.map((item) =>
        item.id === episode.id ? { ...item, [kind]: marker, analyzedAt: new Date().toISOString() } : item,
      ),
    }))
  }

  const removeSeries = (id: string) => {
    setLibrary((current) => ({ series: current.series.filter((item) => item.id !== id) }))
    if (seriesId === id) {
      const rest = library.series.find((item) => item.id !== id)
      setSeriesId(rest?.id ?? null)
      setEpisodeId(rest?.episodes[0]?.id ?? null)
    }
  }

  const removeEpisode = (id: string) => {
    if (!series) return
    updateSeries(series.id, (current) => ({
      ...current,
      episodes: current.episodes.filter((item) => item.id !== id),
    }))
    if (episodeId === id) setEpisodeId(null)
  }

  const goNext = useCallback(() => {
    if (!series) return
    const next = nextEpisode
    if (next) setEpisodeId(next.id)
  }, [series, nextEpisode])

  const progressText = progress
    ? `${progress.phase === 'extract' ? 'Extraindo áudio' : 'Comparando'} ${progress.kind?.toUpperCase() ?? ''} · ${progress.index + 1}/${progress.total}${progress.file ? ` · ${progress.file.split(/[\\/]/).pop()}` : ''}`
    : busy

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <span className="logo">▶</span>
          <div>
            <strong>OPED Finder</strong>
            <small>aberturas e encerramentos</small>
          </div>
        </header>

        <button className="primary" onClick={addSeries} disabled={busy !== null}>
          + Adicionar série
        </button>

        <button className="primary" onClick={() => setBatchOpen(true)} disabled={busy !== null}>
          Batch: analisar catálogo
        </button>

        <button className="primary" onClick={() => setHistoryOpen(true)} disabled={busy !== null}>
          Histórico de OP/ED
        </button>

        <ul className="series-list">
          {library.series.map((item) => {
            const analyzed = item.episodes.filter((episodeItem) => episodeItem.op).length
            return (
              <li key={item.id} className={item.id === seriesId ? 'active' : ''}>
                <button onClick={() => {
                  setSeriesId(item.id)
                  setEpisodeId(item.episodes[0]?.id ?? null)
                }}>
                  <span className="series-title">{item.title}</span>
                  <span className="series-sub">{item.episodes.length} ep · {analyzed} com OP</span>
                </button>
                <button className="icon" title="Remover série" onClick={() => removeSeries(item.id)}>×</button>
              </li>
            )
          })}
          {loaded && library.series.length === 0 && (
            <li className="empty">Nenhuma série ainda. Clique em “Adicionar série”.</li>
          )}
        </ul>

        <div className="settings">
          <label>
            <input
              type="checkbox"
              checked={settings.autoSkipOp}
              onChange={(event) => setSettings({ ...settings, autoSkipOp: event.target.checked })}
            />
            Pular OP automaticamente
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.autoAdvance}
              onChange={(event) => setSettings({ ...settings, autoAdvance: event.target.checked })}
            />
            Ir para o próximo no ED
          </label>
        </div>
      </aside>

      <main className="main">
        {series ? (
          <>
            <header className="series-header">
              <div>
                <h1>{series.title}</h1>
                <p className="folder" title={series.folder}>{series.folder}</p>
              </div>
              <div className="header-actions">
                <button className="primary" onClick={analyze} disabled={busy !== null}>
                  {busy ? 'Analisando…' : 'Analisar OP/ED'}
                </button>
                <button onClick={addEpisodes} disabled={busy !== null}>+ Episódios</button>
              </div>
            </header>

            {progressText && (
              <div className="progress-bar">
                <div className="progress-text">{progressText}</div>
                {progress && (
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${((progress.index + 1) / Math.max(1, progress.total)) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="content">
              {episode ? (
                <Player
                  episode={episode}
                  hasNext={nextEpisode !== null}
                  settings={settings}
                  onUpdateMarker={updateMarker}
                  onNext={goNext}
                />
              ) : (
                <div className="placeholder">
                  <p>Selecione um episódio na lista ao lado.</p>
                </div>
              )}

              <aside className="episodes">
                <h2>Episódios</h2>
                <ul>
                  {series.episodes.map((item) => (
                    <li key={item.id} className={item.id === episodeId ? 'active' : ''}>
                      <button className="episode-button" onClick={() => setEpisodeId(item.id)}>
                        <span className="episode-name">{item.name}</span>
                        <span className="episode-tags">
                          {item.op
                            ? <em className="tag op">{formatTime(item.op.start)}</em>
                            : <em className="tag muted">sem OP</em>}
                          {item.ed && <em className="tag ed">{formatTime(item.ed.start)}</em>}
                        </span>
                      </button>
                      <button className="icon" title="Remover episódio" onClick={() => removeEpisode(item.id)}>×</button>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>
          </>
        ) : (
          <div className="placeholder big">
            <h1>OPED Finder</h1>
            <p>Adicione uma pasta com os episódios de uma série. O app compara o áudio dos episódios, descobre o trecho que se repete (a abertura) e o do final (encerramento), e guarda o tempo.</p>
            <button className="primary" onClick={addSeries} disabled={busy !== null}>+ Adicionar série</button>
          </div>
        )}
      </main>

      {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}

      {batchOpen && (
        <BatchPanel onClose={() => setBatchOpen(false)} />
      )}

      {historyOpen && (
        <HistoryPanel library={library} onClose={() => setHistoryOpen(false)} />
      )}

      {batchProgress && batchVisible && (
        <section className="batch-progress visible">
          <div className="batch-progress-header">
            <h3>Batch em andamento</h3>
            <button className="batch-progress-close" onClick={() => setBatchVisible(false)}>×</button>
          </div>
          <div className="batch-progress-bar">
            <div className="batch-progress-fill" style={{ width: `${(batchProgress.current / Math.max(1, batchProgress.total)) * 100}%` }} />
          </div>
          <div className="batch-progress-text">
            {batchProgress.current} / {batchProgress.total} · {batchProgress.text}
          </div>
          <div className="batch-progress-log">
            {batchLogs.slice(-12).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </section>
      )}
    </div>
  )
}
