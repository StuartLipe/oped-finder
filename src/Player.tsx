import { useCallback, useEffect, useRef, useState } from 'react'
import type { Episode, Marker } from './types'

export interface PlayerSettings {
  autoSkipOp: boolean
  autoSkipEd: boolean
  autoAdvance: boolean
}

interface Props {
  episode: Episode
  hasNext: boolean
  settings: PlayerSettings
  onUpdateMarker: (kind: 'op' | 'ed', marker: Marker | null) => void
  onNext: () => void
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export default function Player({ episode, hasNext, settings, onUpdateMarker, onNext }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const didSkipOp = useRef(false)
  const didAdvance = useRef(false)

  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(episode.duration || 0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setSrc(null)
    setTime(0)
    didSkipOp.current = false
    didAdvance.current = false
    setDuration(episode.duration || 0)

    window.oped
      .prepareMedia(episode.file)
      .then((result) => {
        if (!alive) return
        setSrc(window.oped.mediaUrl(result.path))
      })
      .catch((cause: Error) => {
        if (!alive) return
        setError(cause.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [episode.file, episode.duration])

  const seek = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    const max = Number.isFinite(video.duration) ? video.duration : duration
    video.currentTime = Math.min(Math.max(0, value), Math.max(0, max - 0.25))
    setTime(video.currentTime)
  }, [duration])

  const skipOp = useCallback(() => {
    if (!episode.op) return
    seek(episode.op.end + 0.15)
  }, [episode.op, seek])

  const handleTime = () => {
    const video = videoRef.current
    if (!video) return
    const now = video.currentTime
    setTime(now)

    const op = episode.op
    if (op && now >= op.start - 0.4 && now < op.end - 0.3) {
      if (settings.autoSkipOp && !didSkipOp.current) {
        didSkipOp.current = true
        video.currentTime = op.end + 0.15
      }
    } else if (op && now < op.start - 2) {
      didSkipOp.current = false
    }

    const ed = episode.ed
    if (ed && settings.autoAdvance && hasNext && now >= ed.start + 0.1 && !didAdvance.current) {
      didAdvance.current = true
      onNext()
    }
    if (ed && now < ed.start - 3) didAdvance.current = false
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const video = videoRef.current
      if (!video) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (video.paused) void video.play()
        else video.pause()
      } else if (event.code === 'ArrowRight') {
        event.preventDefault()
        seek(video.currentTime + 5)
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault()
        seek(video.currentTime - 5)
      } else if (event.key.toLowerCase() === 's') {
        skipOp()
      } else if (event.key.toLowerCase() === 'n' && hasNext) {
        onNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasNext, onNext, seek, skipOp])

  const total = duration || 1
  const inOp = episode.op != null && time >= episode.op.start - 0.5 && time < episode.op.end
  const inEd = episode.ed != null && time >= episode.ed.start && time < episode.ed.end + 1

  const markerStyle = (marker: Marker | null, color: string) => {
    if (!marker) return undefined
    const left = Math.max(0, Math.min(100, (marker.start / total) * 100))
    const width = Math.max(0.4, Math.min(100 - left, ((marker.end - marker.start) / total) * 100))
    return { left: `${left}%`, width: `${width}%`, background: color }
  }

  const mark = (kind: 'op' | 'ed', edge: 'start' | 'end') => {
    const current = kind === 'op' ? episode.op : episode.ed
    const value = time
    if (edge === 'start') {
      onUpdateMarker(kind, {
        start: value,
        end: Math.max(value + 1, current?.end ?? value + 90),
        confidence: 1,
        source: 'manual',
      })
    } else {
      onUpdateMarker(kind, {
        start: Math.min(value - 1, current?.start ?? Math.max(0, value - 90)),
        end: value,
        confidence: 1,
        source: 'manual',
      })
    }
  }

  return (
    <section className="player">
      <div className="player-stage">
        {src && (
          <video
            ref={videoRef}
            src={src}
            controls
            autoPlay
            onTimeUpdate={handleTime}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || episode.duration)}
            onEnded={() => {
              if (hasNext && settings.autoAdvance) onNext()
            }}
          />
        )}
        {loading && <div className="stage-message">Preparando vídeo…</div>}
        {!loading && !src && <div className="stage-message error">{error || 'Não foi possível abrir o vídeo.'}</div>}

        {inOp && (
          <button className="skip-button" onClick={skipOp}>
            Pular abertura <kbd>S</kbd>
          </button>
        )}
        {inEd && !inOp && (
          <button className="skip-button next" onClick={onNext} disabled={!hasNext}>
            {hasNext ? 'Próximo episódio' : 'Fim da série'} <kbd>N</kbd>
          </button>
        )}
      </div>

      <div className="timeline" ref={barRef} onClick={(event) => {
        const rect = barRef.current?.getBoundingClientRect()
        if (!rect) return
        const ratio = (event.clientX - rect.left) / rect.width
        seek(ratio * total)
      }}>
        <div className="timeline-base" />
        <div className="timeline-marker op" style={markerStyle(episode.op, '#37d67a')} title="Abertura" />
        <div className="timeline-marker ed" style={markerStyle(episode.ed, '#4f9dff')} title="Encerramento" />
        <div className="timeline-head" style={{ left: `${(time / total) * 100}%` }} />
      </div>

      <div className="player-meta">
        <span className="time">{formatTime(time)} / {formatTime(duration)}</span>
        <div className="marker-info">
          {episode.op ? (
            <span className="pill op">OP {formatTime(episode.op.start)}–{formatTime(episode.op.end)}
              <em>{episode.op.source === 'manual' ? 'manual' : `${Math.round(episode.op.confidence * 100)}%`}</em>
            </span>
          ) : <span className="pill muted">OP não marcado</span>}
          {episode.ed ? (
            <span className="pill ed">ED {formatTime(episode.ed.start)}–{formatTime(episode.ed.end)}
              <em>{episode.ed.source === 'manual' ? 'manual' : `${Math.round(episode.ed.confidence * 100)}%`}</em>
            </span>
          ) : <span className="pill muted">ED não marcado</span>}
        </div>
        <div className="marker-actions">
          <button onClick={() => mark('op', 'start')}>OP início</button>
          <button onClick={() => mark('op', 'end')}>OP fim</button>
          <button onClick={() => mark('ed', 'start')}>ED início</button>
          <button onClick={() => mark('ed', 'end')}>ED fim</button>
          <button className="ghost" onClick={() => { onUpdateMarker('op', null); onUpdateMarker('ed', null) }}>limpar</button>
        </div>
      </div>
    </section>
  )
}
