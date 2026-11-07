'use strict'

/*
 * Núcleo de análise do OPED Finder.
 *
 * Ideia: o OP (e o ED) é o MESMO trecho de áudio repetido em todos os episódios.
 * Então, em vez de tentar "adivinhar" música, comparamos o áudio de episódios
 * diferentes e procuramos o trecho que aparece igual em ambos. O que se repete
 * no começo é o OP; o que se repete no fim é o ED.
 *
 * Passos:
 *   1. ffmpeg extrai PCM mono 11 kHz só das regiões de interesse (início/fim).
 *   2. Cada 0,5 s vira um vetor de 16 bandas de energia (log) normalizado.
 *   3. Entre dois episódios, varremos todas as diagonais de tempo e escolhemos
 *      a janela de 60 s com maior similaridade média (cosseno).
 *   4. Estendemos a janela enquanto a similaridade continuar alta e agregamos
 *      os resultados de vários pares (mediana + votos) para achar o intervalo.
 */

const { spawn } = require('node:child_process')
const path = require('node:path')

const ffmpegPath = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static')

const SR = 11025
const FRAME = 4096
const HOP = 5512 // 0.5 s
const BANDS = 16
const MIN_SIM = 0.72
const MATCH_FLOOR = 0.8
const MIN_MATCH = 0.85
const MIN_RUN = 30 // 15 s — menor trecho aceito como OP/ED
const MIN_VOTES = 2

/* Cache de PCM extraído: chave = `${file}|${start}|${dur}`.
 * Evita re-extrair o mesmo áudio quando comparamos vários episódios
 * ou tentamos janelas diferentes. */
const pcmCache = new Map()

function cacheKey(file, start, dur) {
  return `${file}|${Math.round(start * 100)}|${Math.round(dur * 100)}`
}

function extractPcmCached(file, start, duration) {
  const key = cacheKey(file, start, duration)
  if (pcmCache.has(key)) return pcmCache.get(key)
  const prom = extractPcm(file, start, duration).then((samples) => {
    pcmCache.set(key, samples)
    return samples
  })
  pcmCache.set(key, prom)
  return prom
}

const BAND_EDGES = (() => {
  const lo = 60
  const hi = 5000
  const edges = []
  for (let i = 0; i <= BANDS; i++) {
    edges.push(lo * Math.pow(hi / lo, i / BANDS))
  }
  return edges
})()

function runProbe(file) {
  return new Promise((resolve, reject) => {
    const ps = spawn(ffprobeStatic.path, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name',
      '-of', 'json',
      file,
    ])
    let out = ''
    let err = ''
    ps.stdout.on('data', (c) => (out += c))
    ps.stderr.on('data', (c) => (err += c))
    ps.on('error', reject)
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || 'ffprobe falhou'))
      try {
        const data = JSON.parse(out)
        const streams = data.streams || []
        resolve({
          duration: Number(data.format?.duration || 0),
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          hasVideo: streams.some((s) => s.codec_type === 'video'),
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

function extractPcm(file, start, duration, onBytes) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-ss', String(Math.max(0, start)),
      '-t', String(Math.max(0.5, duration)),
      '-i', file,
      '-vn', '-ac', '1', '-ar', String(SR),
      '-f', 's16le', '-',
    ]
    const ps = spawn(ffmpegPath, args)
    const chunks = []
    let total = 0
    ps.stdout.on('data', (c) => {
      chunks.push(c)
      total += c.length
      if (onBytes) onBytes(total)
    })
    let err = ''
    ps.stderr.on('data', (c) => (err += c))
    ps.on('error', reject)
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || 'ffmpeg falhou'))
      const buf = Buffer.concat(chunks)
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
      resolve(samples)
    })
  })
}

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

const hann = (() => {
  const w = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  return w
})()

// Energia por banda em cada frame de 0,5 s -> vetor normalizado (média 0, norma 1).
function fingerprint(samples) {
  const binHz = SR / FRAME
  const bandIndex = new Int32Array(FRAME / 2 + 1).fill(-1)
  for (let k = 1; k <= FRAME / 2; k++) {
    const hz = k * binHz
    for (let b = 0; b < BANDS; b++) {
      if (hz >= BAND_EDGES[b] && hz < BAND_EDGES[b + 1]) {
        bandIndex[k] = b
        break
      }
    }
  }

  const frames = []
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  for (let pos = 0; pos + FRAME <= samples.length; pos += HOP) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = (samples[pos + i] / 32768) * hann[i]
      im[i] = 0
    }
    fft(re, im)
    const bands = new Float32Array(BANDS)
    for (let k = 1; k <= FRAME / 2; k++) {
      const b = bandIndex[k]
      if (b < 0) continue
      bands[b] += re[k] * re[k] + im[k] * im[k]
    }
    let mean = 0
    for (let b = 0; b < BANDS; b++) {
      bands[b] = Math.log10(bands[b] + 1e-9)
      mean += bands[b]
    }
    mean /= BANDS
    let norm = 0
    for (let b = 0; b < BANDS; b++) {
      bands[b] -= mean
      norm += bands[b] * bands[b]
    }
    norm = Math.sqrt(norm) || 1
    for (let b = 0; b < BANDS; b++) bands[b] /= norm
    frames.push(bands)
  }
  return frames
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < BANDS; i++) s += a[i] * b[i]
  return s
}

/*
 * Acha o melhor trecho comum entre duas impressões digitais.
 *
 * Em vez de janela fixa, usa Kadane sobre (similaridade - piso): o resultado é
 * o maior trecho contíguo que se mantém acima do piso, o que lida bem com OP
 * de 90 s e ED de 45 s sem diluir a média com o fundo diferente dos episódios.
 *
 * Retorna { i, j, length, score } em frames, ou null.
 */
function bestCommonSegment(a, b) {
  const n = a.length
  const m = b.length
  if (n < MIN_RUN || m < MIN_RUN) return null

  let best = null
  for (let d = -(n - MIN_RUN); d <= m - MIN_RUN; d++) {
    const iStart = Math.max(0, -d)
    const iEnd = Math.min(n, m - d)
    if (iEnd - iStart < MIN_RUN) continue

    let sum = 0
    let bestSum = -Infinity
    let bestStart = iStart
    let bestEnd = iStart
    let runStart = iStart
    for (let i = iStart; i < iEnd; i++) {
      const value = dot(a[i], b[i + d]) - MATCH_FLOOR
      if (sum <= 0) {
        sum = value
        runStart = i
      } else {
        sum += value
      }
      if (sum > bestSum) {
        bestSum = sum
        bestStart = runStart
        bestEnd = i
      }
    }

    const length = bestEnd - bestStart + 1
    if (length < MIN_RUN) continue
    const score = (bestSum + MATCH_FLOOR * length) / length

    if (!best) {
      best = { i: bestStart, j: bestStart + d, length, score }
      continue
    }
    // Prefere o trecho mais longo quando a qualidade é praticamente a mesma.
    const better = score > best.score + 0.02 || (score >= best.score - 0.02 && length > best.length)
    if (better) best = { i: bestStart, j: bestStart + d, length, score }
  }

  if (!best || best.score < MIN_MATCH) return null

  // Estende para os lados enquanto o trecho continuar parecido.
  const simAt = (i, j) => (i >= 0 && j >= 0 && i < n && j < m ? dot(a[i], b[j]) : -1)
  let left = 0
  let misses = 0
  while (best.i - left - 1 >= 0 && best.j - left - 1 >= 0) {
    if (simAt(best.i - left - 1, best.j - left - 1) >= MIN_SIM) {
      misses = 0
      left++
    } else if (++misses > 2) break
    else left++
  }
  let right = 0
  misses = 0
  const endI = best.i + best.length
  const endJ = best.j + best.length
  while (endI + right < n && endJ + right < m) {
    if (simAt(endI + right, endJ + right) >= MIN_SIM) {
      misses = 0
      right++
    } else if (++misses > 2) break
    else right++
  }

  const startI = best.i - left
  const startJ = best.j - left
  const length = best.length + left + right
  return {
    i: startI,
    j: startJ,
    length,
    score: best.score,
    startA: (startI * HOP) / SR,
    endA: ((startI + length) * HOP) / SR,
    startB: (startJ * HOP) / SR,
    endB: ((startJ + length) * HOP) / SR,
  }
}

function median(values) {
  if (!values.length) return 0
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function clusterSegments(candidates) {
  if (!candidates.length) return null
  const sorted = [...candidates].sort((x, y) => x.start - y.start)
  let bestCluster = []
  for (const seed of sorted) {
    const group = sorted.filter((c) => Math.abs(c.start - seed.start) <= 6)
    if (group.length > bestCluster.length) bestCluster = group
  }
  if (bestCluster.length < MIN_VOTES) return null
  const start = median(bestCluster.map((c) => c.start))
  const end = median(bestCluster.map((c) => c.end))
  if (end - start < 8) return null
  return {
    start,
    end,
    confidence: bestCluster.length / candidates.length,
    votes: bestCluster.length,
  }
}

async function analyzeRegion(files, region, onProgress) {
  // region: { kind: 'op' | 'ed', bounds: (dur) => [start, end] }
  const perFile = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    onProgress?.({ phase: 'extract', index, total: files.length, file, kind: region.kind })
    const info = await runProbe(file)
    if (!info.hasAudio || info.duration < 60) {
      perFile.push({ file, frames: null, offset: 0, duration: info.duration })
      continue
    }
    const [start, end] = region.bounds(info.duration)
    const pcm = await extractPcmCached(file, start, end - start)
    perFile.push({ file, frames: fingerprint(pcm), offset: start, duration: info.duration })
  }

  const candidates = []
  const pairSegments = []
  for (let index = 0; index + 1 < perFile.length; index++) {
    const a = perFile[index]
    const b = perFile[index + 1]
    if (!a.frames || !b.frames) continue
    onProgress?.({ phase: 'match', index, total: perFile.length, kind: region.kind })
    const hit = bestCommonSegment(a.frames, b.frames)
    if (!hit) continue
    const segment = {
      a: { start: a.offset + hit.startA, end: a.offset + hit.endA },
      b: { start: b.offset + hit.startB, end: b.offset + hit.endB },
      score: hit.score,
    }
    pairSegments.push({ index, ...segment })
    candidates.push({ start: segment.a.start, end: segment.a.end })
    candidates.push({ start: segment.b.start, end: segment.b.end })
  }

  const series = clusterSegments(candidates)

  const episodes = new Map()
  for (const file of files) {
    episodes.set(file, { start: null, end: null, confidence: 0, source: 'none' })
  }
  for (const pair of pairSegments) {
    for (const [file, seg] of [
      [files[pair.index], pair.a],
      [files[pair.index + 1], pair.b],
    ]) {
      const current = episodes.get(file)
      if (current.start == null) {
        episodes.set(file, { start: seg.start, end: seg.end, confidence: pair.score, source: 'match' })
      }
    }
  }
  // Episódios sem par (ou fora de alcance) herdam a mediana da série.
  if (series) {
    for (const [file, value] of episodes) {
      if (value.start == null) {
        episodes.set(file, {
          start: series.start,
          end: series.end,
          confidence: series.confidence * 0.5,
          source: 'series',
        })
      }
    }
  }

  return {
    kind: region.kind,
    series,
    episodes: [...episodes.entries()].map(([file, value]) => ({ file, ...value, score: 0 })),
  }
}

async function analyzeFiles(files, { onProgress } = {}) {
  const op = await analyzeRegion(
    files,
    { kind: 'op', bounds: (dur) => [Math.min(20, dur * 0.02), Math.min(dur * 0.5, 720)] },
    onProgress,
  )
  const ed = await analyzeRegion(
    files,
    { kind: 'ed', bounds: (dur) => [Math.max(dur * 0.55, dur - 480), Math.max(60, dur - 8)] },
    onProgress,
  )

  const byFile = new Map()
  for (const file of files) byFile.set(file, { file, duration: 0, op: null, ed: null })

  for (const episode of op.episodes) {
    byFile.get(episode.file).op =
      episode.start == null ? null : { start: episode.start, end: episode.end, confidence: episode.confidence, source: episode.source }
  }
  for (const episode of ed.episodes) {
    byFile.get(episode.file).ed =
      episode.start == null ? null : { start: episode.start, end: episode.end, confidence: episode.confidence, source: episode.source }
  }

  return { episodes: [...byFile.values()], opSeries: op.series, edSeries: ed.series }
}

/* ------------------------------------------------------------
 * findOpWithRetries: tenta encontrar o OP em um episódio comparando
 * com outro, tentando várias janelas de tempo. Útil quando a abertura
 * começa logo no início (filmes) ou quando a primeira tentativa falha
 * por causa de silêncio/vinheta diferente no primeiro episódio.
 *
 * Retorna o melhor segmento encontrado ou null.
 ------------------------------------------------------------ */
async function findOpWithRetries(fileA, fileB, onProgress) {
  const probeA = await runProbe(fileA).catch(() => ({ duration: 0 }))
  const probeB = await runProbe(fileB).catch(() => ({ duration: 0 }))
  const durA = probeA.duration || 0
  const durB = probeB.duration || 0
  if (!durA || !durB) return null

  // janelas candidatas (início, duração) para tentar
  const janelas = [
    { start: 0, dur: Math.min(480, durA * 0.5) },
    { start: 0, dur: Math.min(300, durA * 0.4) },
    { start: 30, dur: Math.min(300, durA * 0.4) },
    { start: 60, dur: Math.min(300, durA * 0.4) },
  ]

  for (const janela of janelas) {
    if (janela.start >= durA) continue
    const dA = Math.min(janela.dur, durA - janela.start)
    const dB = Math.min(janela.dur, durB - janela.start)
    if (dA < 30 || dB < 30) continue

    const result = await analyzeRegion(
      [fileA, fileB],
      {
        kind: 'op',
        bounds: () => [janela.start, janela.start + dA],
      },
      onProgress,
    )

    // se achou em ambos os episódios com confiança razoável, devolve
    const epA = result.episodes.find((e) => e.file === fileA)
    const epB = result.episodes.find((e) => e.file === fileB)
    if (epA?.op && epB?.op && epA.op.confidence >= 0.6 && epB.op.confidence >= 0.6) {
      // retorna a união dos dois segmentos (o mais conservador)
      const start = Math.min(epA.op.start, epB.op.start)
      const end = Math.max(epA.op.end, epB.op.end)
      const conf = Math.min(epA.op.confidence, epB.op.confidence)
      return { start, end, confidence: conf, source: 'match' }
    }
  }
  return null
}

module.exports = {
  analyzeFiles,
  analyzeRegion,
  findOpWithRetries,
  runProbe,
  extractPcm,
  extractPcmCached,
  fingerprint,
  bestCommonSegment,
  constants: { SR, HOP, FRAME, MIN_RUN },
  tools: { ffmpegPath, ffprobePath: ffprobeStatic.path },
}
