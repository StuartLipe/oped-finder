import { useMemo, useState } from 'react'
import type { Episode, Library } from './types'

interface Props {
  library: Library
  onClose: () => void
}

export default function HistoryPanel({ library, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const rows = useMemo(() => {
    const out: Array<{
      nome: string
      serieId: string
      total: number
      comOp: number
      comEd: number
      episodios: Episode[]
    }> = []

    for (const serie of library.series || []) {
      const eps = serie.episodes || []
      const comOp = eps.filter((e) => e.op).length
      const comEd = eps.filter((e) => e.ed).length
      if (!eps.length) continue
      const nome = serie.title
      if (nome.toLowerCase().includes(search.toLowerCase())) {
        out.push({
          nome,
          serieId: serie.id,
          total: eps.length,
          comOp,
          comEd,
          episodios: eps,
        })
      }
    }
    return out.sort((a, b) => b.comOp + b.comEd - (a.comOp + a.comEd))
  }, [library, search])

  const totalSeries = rows.length
  const totalEps = rows.reduce((s, r) => s + r.total, 0)
  const totalOp = rows.reduce((s, r) => s + r.comOp, 0)
  const totalEd = rows.reduce((s, r) => s + r.comEd, 0)

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <section className="history-panel">
      <div className="history-header">
        <h2>Histórico — OP/ED já feitos</h2>
        <button onClick={onClose}>Fechar</button>
      </div>

      <div className="history-body">
        <div className="history-summary">
          <div className="stat">
            <div className="stat-value">{totalSeries}</div>
            <div className="stat-label">séries</div>
          </div>
          <div className="stat">
            <div className="stat-value">{totalEps}</div>
            <div className="stat-label">episódios</div>
          </div>
          <div className="stat">
            <div className="stat-value">{totalOp}</div>
            <div className="stat-label">com OP</div>
          </div>
          <div className="stat">
            <div className="stat-value">{totalEd}</div>
            <div className="stat-label">com ED</div>
          </div>
        </div>

        <div className="history-search">
          <input
            type="text"
            placeholder="Buscar anime…"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          />
        </div>

        <ul className="history-list">
          {rows.map((row) => {
            const isOpen = !!expanded[row.serieId]
            return (
              <li key={row.serieId} className="history-item">
                <button
                  className="history-title"
                  onClick={() => toggle(row.serieId)}
                >
                  {isOpen ? '▼' : '▶'} {row.nome}
                  <span className="history-count">
                    {row.comOp}/{row.total} OP · {row.comEd}/{row.total} ED
                  </span>
                </button>
                {isOpen && (
                  <ul className="history-eps">
                    {row.episodios.map((ep) => (
                      <li key={ep.id} className="history-ep">
                        <span className="history-ep-num">{ep.name}</span>
                        <span className={`history-tag ${ep.op ? 'has-op' : 'no-op'}`}>
                          {ep.op ? `OP ${Math.round(ep.op.start)}–${Math.round(ep.op.end)}` : 'sem OP'}
                        </span>
                        <span className={`history-tag ${ep.ed ? 'has-ed' : 'no-ed'}`}>
                          {ep.ed ? `ED ${Math.round(ep.ed.start)}–${Math.round(ep.ed.end)}` : 'sem ED'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
          {rows.length === 0 && (
            <div className="history-empty">Nenhum anime encontrado.</div>
          )}
        </ul>
      </div>
    </section>
  )
}
