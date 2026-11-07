import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  onClose: () => void
  onBackdropClick?: () => void
}

export default function BatchPanel({ onClose, onBackdropClick }: Props) {
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; log: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const log = useCallback((text: string) => {
    setLogs((prev) => [...prev, text])
  }, [])

  useEffect(() => {
    const unsubscribe = window.oped.onBatchLog((text) => {
      const lines = text.split(/\r?\n/).filter(Boolean)
      lines.forEach((line) => log(line))
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  const runBatch = async () => {
    setRunning(true)
    setResult(null)
    setLogs([])
    try {
      const res = await window.oped.runBatch(['--v'])
      setResult(res)
      if (res.log) {
        res.log.split(/\r?\n/).forEach((line) => line && log(line))
      }
    } catch (error: any) {
      log('ERRO: ' + error.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="batch-panel" onClick={onBackdropClick ? (e) => { if (e.target === e.currentTarget) onBackdropClick() } : undefined}>
      <div className="batch-backdrop" onClick={onBackdropClick ? (e) => { if (e.target === e.currentTarget) onBackdropClick() } : undefined} />
      <div className="batch-content" onClick={(e) => e.stopPropagation()}>
        <div className="batch-header">
          <h2>Modo Batch — Catálogo do Painel</h2>
          <button onClick={onClose}>Fechar</button>
        </div>

      <div className="batch-body">
        <div className="batch-actions">
          <button className="primary" onClick={runBatch} disabled={running}>
            {running ? 'Analisando catálogo…' : 'Rodar análise de OP/ED'}
          </button>
          <span className="hint">
            Pula séries que já têm OP/ED e analisa só o que falta no painel ({window.location.hostname}).
          </span>
        </div>

        <div className="batch-log" ref={scrollRef}>
          {logs.length ? logs.map((l, i) => <div key={i}>{l}</div>) : <div className="muted">Nenhum log ainda.</div>}
        </div>

        {result && (
          <div className={`batch-result ${result.ok ? 'ok' : 'error'}`}>
            {result.ok ? '✓ Concluído.' : '✗ Falhou.'} {result.log ? ` — ${result.log}` : ''}
          </div>
        )}
      </div>
      </div>
    </section>
  )
}
