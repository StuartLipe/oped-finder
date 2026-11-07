#!/usr/bin/env node
/* ------------------------------------------------------------
 * OPED Finder - modo batch episódio-por-episodio
 *
 * 1. Lê o catálogo do painel Xtream (ggfiberpre.fun)
 * 2. Compara com oped-data.ts e lista episódios faltando OP/ED
 * 3. Para cada episódio faltante: compara áudio com outro ep da
 *    mesma série, descobre OP/ED, grava de volta em oped-data.ts
 * 4. Emite progresso em linha para o app exibir em tempo real
 *
 * Uso:
 *   npm run batch          # analisa tudo o que falta
 *   npm run batch -- --dry # só mostra o que faria (não grava)
 *   npm run batch -- --mal 21  # só uma série (MAL id)
 ------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { analyzeFiles, runProbe, findOpWithRetries } from '../electron/analyzer.cjs'

const require = createRequire(import.meta.url)
const FFMPEG = require('ffmpeg-static')

const U = '639563670'
const P = '334918348'
const B = 'http://ggfiberpre.fun'
const TMP = 'C:/Users/Administrator/AppData/Local/Temp'
const ST = 'C:/Users/Administrator/Documents/st/src/lib'
const OPED_FILE = path.join(ST, 'oped-data.ts')

const dryRun = process.argv.includes('--dry')
const verbose = process.argv.includes('--v')
const malFiltro = process.argv.find((a) => a.startsWith('--mal='))?.split('=')[1]

const log = (...a) => { if (verbose || dryRun) console.log(...a) }
const progress = (text) => process.stdout.write(`PROGRESS:${text}\n`)

const norm = (nome) => String(nome ?? '')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\b[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}\b/g, ' ')
  .replace(/\b(?:S|T)\d{1,3}\b/gi, ' ')
  .replace(/(?:^|[\s._\-[(])EP?IS[O\u00d3\u00c3]DIO?[\s._\-]*\d{1,4}\b/gi, ' ')
  .replace(/(?:^|[\s._\-[(])EP?[\s._\-]*\d{1,3}\b/gi, ' ')
  .replace(/\b(?:season|temporada|dublado|dublada|legendado|legendada)\b/gi, ' ')
  .replace(/[^a-z0-9]+/gi, ' ')
  .trim()
  .toLowerCase()

// ---------- carrega OPED ----------
const OPED = new Map()
{
  const lines = fs.readFileSync(OPED_FILE, 'utf8').split(/\r?\n/)
  let malId = null, season = null
  for (const raw of lines) {
    const m1 = /^  '(\d+)': \{/.exec(raw)
    const m2 = /^    '([^']+)': \{/.exec(raw)
    const m3 = /^      '(\d+)': \{ (.*) \},?$/.exec(raw)
    if (m1) { malId = m1[1]; if (!OPED.has(malId)) OPED.set(malId, new Map()); season = null; continue }
    if (m2 && malId) { season = m2[1]; if (!OPED.get(malId).has(season)) OPED.get(malId).set(season, new Map()); continue }
    if (m3 && malId && season) {
      const body = m3[2]
      OPED.get(malId).get(season).set(m3[1], {
        op: /op: \{ start: ([\d.]+), end: ([\d.]+) \}/.test(body),
        ed: /ed: \{ start: ([\d.]+), end: ([\d.]+) \}/.test(body),
      })
    }
  }
}
console.log('Séries com dados OPED:', OPED.size)

// ---------- carrega MAL ----------
const malTs = fs.readFileSync(path.join(ST, 'anime-mal-ids.ts'), 'utf8')
const MAL = new Map()
for (const m of malTs.matchAll(/^\s*"([^"]+)"\s*:\s*"(\d+)"/gm)) MAL.set(m[1], m[2])

// ---------- API ----------
async function api(action, extra = '') {
  const res = await fetch(`${B}/player_api.php?username=${U}&password=${P}&action=${action}${extra}`, { signal: AbortSignal.timeout(180000) })
  if (!res.ok) throw new Error(`${action} ${res.status}`)
  return res.json()
}

// ---------- pcm ----------
async function pcmWindow(fileUrl, start, dur) {
  const out = path.join(TMP, `batch_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`)
  execFileSync(FFMPEG, [
    '-v', 'error', '-ss', String(start), '-t', String(dur),
    '-i', fileUrl, '-vn', '-ac', '1', '-ar', '11025', '-f', 's16le', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
}

// ---------- analisa um episódio ----------
async function analisarEpisodio(info, mal, skey, e) {
  const seasonNum = String(e.season ?? skey)
  const epNum = Number(e.episode_num)
  const file = `${B}/series/${U}/${P}/${e.id}.${e.container_extension}`
  const probe = await runProbe(file).catch(() => ({ duration: 0 }))
  if (!probe.duration) return { ok: false, motivo: 'sem duração' }

  // busca outro episódio da mesma série/temporada para comparar
  const outro = info.episodes[skey]?.find((x) => x.id !== e.id)
    ?? Object.values(info.episodes).flat().find((x) => x.id !== e.id)
  if (!outro) return { ok: false, motivo: 'sem outro ep' }

  const outroFile = `${B}/series/${U}/${P}/${outro.id}.${outro.container_extension}`
  const probeOutro = await runProbe(outroFile).catch(() => ({ duration: 0 }))
  if (!probeOutro.duration) return { ok: false, motivo: 'outro sem duração' }

  const dur = probe.duration
  const opDur = Math.min(480, dur * 0.4)
  const edStart = Math.max(dur - 480, dur * 0.6)
  const edDur = dur - edStart

  const result = await analyzeFiles([file, outroFile], {
    onProgress: (p) => log(`   ${mal} ep${epNum} ${p.phase} ${p.kind} ${p.index + 1}/${p.total}`),
  })

  const byFile = new Map(result.episodes.map((x) => [x.file, x]))
  const found = byFile.get(file)
  if (!found) return { ok: false, motivo: 'não encontrado na análise' }

  let opMark = found.op
  if (!opMark) {
    const retry = await findOpWithRetries(file, outroFile, (p) => log(`   ${mal} ep${epNum} retry ${p.kind}`))
    if (retry) opMark = { start: retry.start, end: retry.end, confidence: retry.confidence }
  }

  return {
    ok: true,
    temporada: seasonNum,
    episodio: epNum,
    op: opMark ? { start: Math.round(opMark.start * 100) / 100, end: Math.round(opMark.end * 100) / 100, confidence: Math.round(opMark.confidence * 100) / 100 } : null,
    ed: found.ed ? { start: Math.round(found.ed.start * 100) / 100, end: Math.round(found.ed.end * 100) / 100, confidence: Math.round(found.ed.confidence * 100) / 100 } : null,
    len: Math.round(dur * 100) / 100,
  }
}

// ---------- grava de volta ----------
function gravarOPED(novos) {
  let conteudo = fs.readFileSync(OPED_FILE, 'utf8')
  const linhas = conteudo.split(/\r?\n/)

  // remove entradas dos MALs que vamos regravar (parse linha a linha, sem regex)
  const mals = [...new Set(novos.map((n) => n.mal))]
  const manter = []
  let skip = false
  let nivel = 0
  for (const linha of linhas) {
    const ehMal = /^  '(\d+)': \{/.test(linha)
    if (ehMal) {
      const m = /^  '(\d+)': \{/.exec(linha)
      skip = mals.includes(m[1])
      nivel = 0
      if (!skip) manter.push(linha)
      continue
    }
    if (skip) {
      // conta chaves para saber quando o bloco do MAL terminou
      for (const c of linha) { if (c === '{') nivel++; if (c === '}') nivel-- }
      if (nivel <= 0) skip = false
      continue
    }
    manter.push(linha)
  }
  conteudo = manter.join('\n')

  // agrupa novos por mal -> temporada -> episodio
  const grupos = new Map()
  for (const n of novos) {
    if (!grupos.has(n.mal)) grupos.set(n.mal, new Map())
    const tempMap = grupos.get(n.mal)
    if (!tempMap.has(n.temporada)) tempMap.set(n.temporada, {})
    tempMap.get(n.temporada)[n.episodio] = n
  }

  for (const [mal, tempMap] of grupos) {
    let bloco = `\n  '${mal}': {\n`
    for (const [temp, eps] of tempMap) {
      bloco += `    '${temp}': {\n`
      for (const [num, mark] of Object.entries(eps)) {
        const op = mark.op ? `op: { start: ${mark.op.start}, end: ${mark.op.end } }, ` : ''
        const ed = mark.ed ? `ed: { start: ${mark.ed.start}, end: ${mark.ed.end } }, ` : ''
        const len = mark.len ? `len: ${mark.len}` : ''
        bloco += `      '${num}': { ${op}${ed}${len} },\n`
      }
      bloco += '    },\n'
    }
    bloco += '  },\n'

    const idx = conteudo.lastIndexOf('};')
    conteudo = conteudo.slice(0, idx) + bloco + conteudo.slice(idx)
  }

  fs.writeFileSync(OPED_FILE, conteudo, 'utf8')
  console.log(`Gravado ${novos.length} episódio(s) de ${mals.length} série(s) em ${OPED_FILE}`)
}

// ---------- main ----------
async function main() {
  const all = await api('get_series')
  console.log('Séries no painel:', all.length)

  const matched = []
  for (const s of all) {
    const key = norm(s.name)
    const mal = MAL.get(key)
    if (!mal) continue
    if (malFiltro && mal !== malFiltro) continue
    matched.push({ ...s, mal, key })
  }
  console.log('Animes com MAL:', matched.length)

  // monta lista de episódios faltando
  const fila = []
  for (const s of matched) {
    try {
      const info = await api('get_series_info', `&series_id=${s.series_id}`)
      const seasons = OPED.get(s.mal)
      for (const [skey, list] of Object.entries(info.episodes || {})) {
        for (const e of list) {
          const seasonNum = String(e.season ?? skey)
          let bucket = seasons?.get(seasonNum)
          if (!bucket && seasons?.has('*')) bucket = seasons.get('*')
          const mark = bucket?.get(String(e.episode_num))
          const temOp = mark?.op, temEd = mark?.ed
          if (!temOp || !temEd) {
            fila.push({ ...s, info, skey, e, temOp, temEd })
          }
        }
      }
    } catch (err) {
      console.log('erro info', s.name, err.message)
    }
  }

  console.log('Episódios faltando OP ou ED:', fila.length)
  if (dryRun) {
    for (const item of fila.slice(0, 50)) {
      console.log(`  ${item.mal} | ${item.nome} | temp ${item.skey} | ep ${item.e.episode_num} | OP ${item.temOp ? 'ok' : 'FALTA'} | ED ${item.temEd ? 'ok' : 'FALTA'}`)
    }
    if (fila.length > 50) console.log(`  ... e mais ${fila.length - 50}`)
    return
  }

  // processa
  const novos = []
  let processados = 0
  for (const item of fila) {
    processados++
    progress(`${processados}/${fila.length}`)
    try {
      const r = await analisarEpisodio(item.info, item.mal, item.skey, item.e)
      if (r.ok) {
        novos.push({ mal: item.mal, ...r })
        log(`  ✓ ${item.nome} temp${r.temporada} ep${r.episodio} OP=${!!r.op} ED=${!!r.ed}`)
      } else {
        log(`  ✗ ${item.nome} temp${item.skey} ep${item.e.episode_num}: ${r.motivo}`)
      }
    } catch (err) {
      log(`  ✗ ${item.nome} temp${item.skey} ep${item.e.episode_num}: ${err.message}`)
    }

    // grava a cada 10 episódios para não perder progresso
    if (novos.length >= 10) {
      gravarOPED(novos.splice(0, novos.length))
    }
  }
  if (novos.length) gravarOPED(novos)

  console.log('\nConcluído. Processados:', processados, '| Novos marcados:', fila.length)
}

main().catch((e) => { console.error('FALHA:', e.message); process.exit(1) })
