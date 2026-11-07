#!/usr/bin/env node
/* ------------------------------------------------------------
 * OPED Finder - modo batch (termina os animes faltantes)
 *
 * 1. Lê o catálogo do painel Xtream (ggfiberpre.fun)
 * 2. Pula séries que já têm OP/ED em oped-data.ts (o seu ~30% feito)
 * 3. Para cada série faltante: compara o áudio de 2 episódios,
 *    descobre o intervalo do OP e do ED, e grava de volta no
 *    formato da sua base (oped-data.ts).
 *
 * Uso:
 *   npm run batch          # analisa só o que falta (modo interativo)
 *   npm run batch -- --dry # não grava, apenas mostra o que faria
 ------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { analyzeFiles, runProbe, findOpWithRetries } from '../electron/analyzer.cjs'
import { createRequire } from 'node:module'
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

const log = (...a) => { if (verbose || dryRun) console.log(...a) }

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

// ---------- carrega mapa MAL ----------
const malTs = fs.readFileSync(path.join(ST, 'anime-mal-ids.ts'), 'utf8')
const MAL = new Map()
for (const m of malTs.matchAll(/^\s*"([^"]+)"\s*:\s*"(\d+)"/gm)) MAL.set(m[1], m[2])

// ---------- carrega OPED existente ----------
const OPED = new Map()
{
  const lines = fs.readFileSync(OPED_FILE, 'utf8').split(/\r?\n/)
  let malId = null, season = null
  for (const raw of lines) {
    const m1 = /^  '(\d+)': \{/.exec(raw)
    const m2 = /^    '([^']+)': \{/.exec(raw)
    if (m1) { malId = m1[1]; if (!OPED.has(malId)) OPED.set(malId, new Map()); season = null; continue }
    if (m2 && malId) { season = m2[1]; if (!OPED.get(malId).has(season)) OPED.get(malId).set(season, new Map()); continue }
  }
}
console.log('Séries já com OP/ED na base:', OPED.size)

// ---------- API painel ----------
async function api(action, extra = '') {
  const res = await fetch(`${B}/player_api.php?username=${U}&password=${P}&action=${action}${extra}`, { signal: AbortSignal.timeout(180000) })
  if (!res.ok) throw new Error(`${action} ${res.status}`)
  return res.json()
}

// ---------- extrai PCM de uma janela ----------
async function pcmWindow(fileUrl, start, dur) {
  const out = path.join(TMP, `batch_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`)
  execFileSync(FFMPEG, [
    '-v', 'error', '-ss', String(start), '-t', String(dur),
    '-i', fileUrl, '-vn', '-ac', '1', '-ar', '11025', '-f', 's16le', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
  return samples
}

// ---------- analisa uma série (2 episódios basta para achar OP/ED) ----------
async function analisarSerie(info, mal) {
  const epList = []
  for (const [skey, list] of Object.entries(info.episodes || {})) {
    for (const e of list) epList.push({ ...e, season: Number(e.season ?? skey) })
  }
  if (epList.length < 2) {
    log(`${mal}: só ${epList.length} episódio, pulando (precisa de ≥2 para comparar)`)
    return null
  }

  // ordena e pega os 2 primeiros episódios distintos
  epList.sort((a, b) => Number(a.episode_num) - Number(b.episode_num))
  const a = epList[0]
  const b = epList[1]

  log(`${mal}: comparando ep ${a.episode_num} (t${a.season}) vs ep ${b.episode_num} (t${b.season})`)

  const probeA = await runProbe(`${B}/series/${U}/${P}/${a.id}.${a.container_extension}`).catch(() => ({ duration: 0 }))
  const probeB = await runProbe(`${B}/series/${U}/${P}/${b.id}.${b.container_extension}`).catch(() => ({ duration: 0 }))
  if (!probeA.duration || !probeB.duration) {
    log(`${mal}: falha ao obter duração`)
    return null
  }

  // janelas: OP no começo (0-480s), ED no fim (dur-480 até dur-8)
  const opA = Math.min(480, probeA.duration * 0.4)
  const opB = Math.min(480, probeB.duration * 0.4)
  const edA = Math.max(probeA.duration - 480, probeA.duration * 0.6)
  const edB = Math.max(probeB.duration - 480, probeB.duration * 0.6)

  const files = [`${B}/series/${U}/${P}/${a.id}.${a.container_extension}`, `${B}/series/${U}/${P}/${b.id}.${b.container_extension}`]

  // Analisa OP e ED juntos (regiões diferentes do mesmo áudio)
  const result = await analyzeFiles(files, {
    onProgress: (p) => log(`   ${p.phase} ${p.kind} ${p.index + 1}/${p.total}`),
  })

  // monta resultado por episódio
  const byFile = new Map(result.episodes.map((e) => [e.file, e]))
  const saida = { mal, episodios: [], opSeries: result.opSeries, edSeries: result.edSeries }

  for (const ep of epList) {
    const f = `${B}/series/${U}/${P}/${ep.id}.${ep.container_extension}`
    const found = byFile.get(f)
    if (!found) continue

    // Se o OP não foi detectado na primeira tentativa, tenta com janelas alternativas.
    let opMark = found.op
    if (!opMark) {
      const outroFile = epList.find((e) => e.id !== ep.id)
        ? `${B}/series/${U}/${P}/${epList.find((e) => e.id !== ep.id).id}.${epList.find((e) => e.id !== ep.id).container_extension}`
        : null
      if (outroFile) {
        const retry = await findOpWithRetries(f, outroFile, (p) => log(`   retry ${p.kind} ${p.index + 1}/${p.total}`))
        if (retry) opMark = { start: retry.start, end: retry.end, confidence: retry.confidence }
      }
    }

    saida.episodios.push({
      temporada: ep.season,
      episodio: Number(ep.episode_num),
      op: opMark ? { start: Math.round(opMark.start * 100) / 100, end: Math.round(opMark.end * 100) / 100, confidence: Math.round(opMark.confidence * 100) / 100 } : null,
      ed: found.ed ? { start: Math.round(found.ed.start * 100) / 100, end: Math.round(found.ed.end * 100) / 100, confidence: Math.round(found.ed.confidence * 100) / 100 } : null,
      len: probeA.duration,
    })
  }
  return saida
}

// ---------- grava de volta no oped-data.ts ----------
function gravarOPED(novos) {
  let conteudo = fs.readFileSync(OPED_FILE, 'utf8')

  // Remove entradas existentes dos MALs que vamos regravar (evita duplicatas)
  for (const { mal } of novos) {
    const regex = new RegExp(`(?ms)  '${mal}': \\{[\\s\\S]*?\\n  \\},?\\n?`)
    conteudo = conteudo.replace(regex, '')
  }

  for (const { mal, episodios } of novos) {
    if (!episodios.length) continue
    const tempMap = new Map()
    for (const ep of episodios) {
      if (!tempMap.has(ep.temporada)) tempMap.set(ep.temporada, {})
      tempMap.get(ep.temporada)[ep.episodio] = ep
    }

    let bloco = `\n  '${mal}': {\n`
    for (const [temp, eps] of tempMap) {
      bloco += `    '${temp}': {\n`
      for (const [num, mark] of Object.entries(eps)) {
        const op = mark.op ? `op: { start: ${mark.op.start}, end: ${mark.op.end } }, ` : ''
        const ed = mark.ed ? `ed: { start: ${mark.ed.start}, end: ${mark.ed.end } }, ` : ''
        const len = mark.len ? `len: ${Math.round(mark.len * 100) / 100}` : ''
        bloco += `      '${num}': { ${op}${ed}${len} },\n`
      }
      bloco += '    },\n'
    }
    bloco += '  },\n'

    const idx = conteudo.lastIndexOf('};')
    conteudo = conteudo.slice(0, idx) + bloco + conteudo.slice(idx)
  }

  fs.writeFileSync(OPED_FILE, conteudo, 'utf8')
  console.log(`Gravado ${novos.length} série(s) em ${OPED_FILE}`)
}

// ---------- main ----------
async function main() {
  const all = await api('get_series')
  console.log('Séries no painel:', all.length)

  const faltantes = []
  for (const s of all) {
    const key = norm(s.name)
    const mal = MAL.get(key)
    if (!mal) continue
    if (OPED.has(mal)) continue
    faltantes.push({ ...s, mal, key })
  }
  console.log('Séries animes sem OP/ED ainda:', faltantes.length)
  for (const s of faltantes) console.log('  -', s.mal.padStart(6), '|', s.name)

  if (dryRun) return

  const novos = []
  for (const s of faltantes) {
    try {
      const info = await api('get_series_info', `&series_id=${s.series_id}`)
      const saida = await analisarSerie(info, s.mal)
      if (saida) novos.push(saida)
    } catch (e) {
      console.log('ERRO', s.name, e.message)
    }
  }

  if (novos.length) await gravarOPED(novos)
  console.log('\nConcluído. Novas séries gravadas:', novos.length)
}

main().catch((e) => { console.error('FALHA:', e.message); process.exit(1) })
