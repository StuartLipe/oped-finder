#!/usr/bin/env node
/*
 * Analisa uma pasta de episódios pelo terminal e grava as marcações em
 * `oped-timestamps.json` ao lado dos vídeos.
 *
 * Uso:
 *   npm run analyze -- "C:\animes\Minha Serie"
 *   npm run analyze -- "C:\animes\Minha Serie" --json
 */
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const { analyzeFiles, runProbe } = require('../electron/analyzer.cjs')

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.ts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv', '.mts'])

async function listVideos(folder, depth = 2) {
  const found = []
  let entries = []
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch (error) {
    throw new Error(`não consegui ler a pasta: ${error.message}`)
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory() && depth > 0) found.push(...(await listVideos(full, depth - 1)))
    else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full)
  }
  return found.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }))
}

const fmt = (seconds) => {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const args = process.argv.slice(2)
const jsonOnly = args.includes('--json')
const folder = args.find((arg) => !arg.startsWith('--'))

if (!folder) {
  console.error('uso: npm run analyze -- "<pasta com os episódios>" [--json]')
  process.exit(1)
}

const files = await listVideos(folder)
if (files.length < 2) {
  console.error(`preciso de pelo menos 2 vídeos em "${folder}" (encontrei ${files.length})`)
  process.exit(1)
}

if (!jsonOnly) {
  console.log(`\n  OPED Finder — ${files.length} episódios em ${folder}\n`)
}

const durations = new Map()
for (const file of files) {
  const info = await runProbe(file).catch(() => ({ duration: 0 }))
  durations.set(file, info.duration)
}

const result = await analyzeFiles(files, {
  onProgress: (progress) => {
    if (jsonOnly) return
    const label = progress.phase === 'extract' ? 'extraindo' : 'comparando'
    process.stdout.write(`\r  ${label} ${progress.kind?.toUpperCase() ?? ''} ${progress.index + 1}/${progress.total}   `)
  },
})

if (!jsonOnly) process.stdout.write('\r' + ' '.repeat(60) + '\r')

const payload = {
  generatedAt: new Date().toISOString(),
  folder,
  series: { op: result.opSeries, ed: result.edSeries },
  episodes: files.map((file) => {
    const found = result.episodes.find((item) => item.file === file)
    return {
      file: path.basename(file),
      duration: Math.round(durations.get(file) ?? 0),
      op: found?.op ? { start: Math.round(found.op.start), end: Math.round(found.op.end), confidence: Number(found.op.confidence.toFixed(2)) } : null,
      ed: found?.ed ? { start: Math.round(found.ed.start), end: Math.round(found.ed.end), confidence: Number(found.ed.confidence.toFixed(2)) } : null,
    }
  }),
}

if (jsonOnly) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('  episódio'.padEnd(46) + 'OP'.padEnd(18) + 'ED')
  for (const episode of payload.episodes) {
    const op = episode.op ? `${fmt(episode.op.start)}–${fmt(episode.op.end)}` : '—'
    const ed = episode.ed ? `${fmt(episode.ed.start)}–${fmt(episode.ed.end)}` : '—'
    console.log(`  ${episode.file.slice(0, 42).padEnd(44)}${op.padEnd(18)}${ed}`)
  }
  if (payload.series.op) console.log(`\n  OP da série: ${fmt(payload.series.op.start)}–${fmt(payload.series.op.end)}`)
  if (payload.series.ed) console.log(`  ED da série: ${fmt(payload.series.ed.start)}–${fmt(payload.series.ed.end)}`)
}

const outFile = path.join(folder, 'oped-timestamps.json')
await fs.writeFile(outFile, JSON.stringify(payload, null, 2), 'utf8')
if (!jsonOnly) console.log(`\n  salvo em ${outFile}\n`)
