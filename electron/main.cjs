'use strict'

const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron')
const { Worker } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')

const ffmpegPath = require('ffmpeg-static')
const { runProbe } = require('./analyzer.cjs')

// Garante a mesma pasta de dados rodando via `npm run desktop` ou direto no electron.exe
app.setName('oped-finder')

// O player abre o episódio já tocando, como um app de vídeo deve fazer.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.ts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv', '.mts',
])
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv'])

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
])

let win = null

function libraryFile() {
  return path.join(app.getPath('userData'), 'library.json')
}

function cacheDir() {
  const dir = path.join(app.getPath('userData'), 'media-cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function readLibrary() {
  try {
    const raw = await fsp.readFile(libraryFile(), 'utf8')
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return Array.isArray(data.series) ? data : { series: [] }
  } catch {
    return { series: [] }
  }
}

async function writeLibrary(library) {
  await fsp.mkdir(path.dirname(libraryFile()), { recursive: true })
  await fsp.writeFile(libraryFile(), JSON.stringify(library, null, 2), 'utf8')
  return true
}

async function listVideos(folder, depth = 1) {
  const out = []
  let entries = []
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory() && depth > 0) {
      out.push(...(await listVideos(full, depth - 1)))
    } else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }))
}

async function makeEpisode(file) {
  let duration = 0
  let hasAudio = true
  try {
    const info = await runProbe(file)
    duration = info.duration
    hasAudio = info.hasAudio
  } catch {
    /* arquivo pode estar em uso; segue sem duração */
  }
  return {
    id: crypto.createHash('sha1').update(file).digest('hex').slice(0, 12),
    file,
    name: path.basename(file),
    duration,
    hasAudio,
    op: null,
    ed: null,
    analyzedAt: null,
  }
}

function remux(file) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(file)
    const key = crypto.createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 16)
    const target = path.join(cacheDir(), `${key}.mp4`)
    if (fs.existsSync(target) && fs.statSync(target).size > 1024) return resolve(target)
    const args = [
      '-hide_banner', '-v', 'error', '-y',
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      target,
    ]
    const ps = spawn(ffmpegPath, args)
    let err = ''
    ps.stderr.on('data', (c) => (err += c))
    ps.on('error', reject)
    ps.on('close', (code) => {
      if (code === 0 && fs.existsSync(target)) resolve(target)
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || 'não foi possível converter o vídeo'))
    })
  })
}

async function handleMedia(request) {
  const url = new URL(request.url)
  const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return new Response('arquivo não encontrado', { status: 404 })
  }
  const range = request.headers.get('range')
  const type = filePath.toLowerCase().endsWith('.webm') ? 'video/webm'
    : filePath.toLowerCase().endsWith('.ogv') ? 'video/ogg'
      : 'video/mp4'

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match && match[1] ? Number(match[1]) : 0
    const end = match && match[2] ? Number(match[2]) : stat.size - 1
    if (start >= stat.size) {
      return new Response('intervalo inválido', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    const stream = fs.createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
    },
  })
}

function startAnalysis(files, sender) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'analyze-worker.cjs'), { workerData: { files } })
    worker.on('message', (message) => {
      if (message.type === 'progress' && !sender.isDestroyed()) {
        sender.send('analyze:progress', message.payload)
      } else if (message.type === 'result') {
        worker.terminate()
        resolve(message.payload)
      } else if (message.type === 'error') {
        worker.terminate()
        reject(new Error(message.message))
      }
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`analisador terminou com código ${code}`))
    })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'OPED Finder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.webContents.on('console-message', (event) => {
    if (process.env.OPED_LOG) console.log('[renderer]', event.message)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => (win = null))
}

app.whenReady().then(() => {
  protocol.handle('media', handleMedia)

  ipcMain.handle('library:load', () => readLibrary())
  ipcMain.handle('library:save', (_event, library) => writeLibrary(library))

  ipcMain.handle('dialog:addSeries', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolha a pasta da série',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const folder = result.filePaths[0]
    const files = await listVideos(folder, 2)
    if (!files.length) return { error: 'Nenhum vídeo encontrado nessa pasta.' }
    const episodes = []
    for (const file of files) episodes.push(await makeEpisode(file))
    return {
      series: {
        id: crypto.randomUUID(),
        title: path.basename(folder),
        folder,
        createdAt: new Date().toISOString(),
        episodes,
      },
    }
  })

  ipcMain.handle('dialog:addFiles', async (_event, seriesId) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolha os episódios',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vídeos', extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],
    })
    if (result.canceled) return null
    const episodes = []
    for (const file of result.filePaths) episodes.push(await makeEpisode(file))
    return { seriesId, episodes }
  })

  ipcMain.handle('analyze:start', async (event, files) => {
    const clean = files.filter((f) => typeof f === 'string' && fs.existsSync(f))
    if (clean.length < 2) {
      throw new Error('Selecione pelo menos 2 episódios da mesma série para comparar o áudio.')
    }
    return startAnalysis(clean, event.sender)
  })

  ipcMain.handle('batch:run', async (_event, args) => {
    const { spawn } = require('node:child_process')
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(__dirname, '..', 'scripts', 'batch.mjs'),
        ...args,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c; if (!win?.isDestroyed()) win.webContents.send('batch:log', c.toString()) })
      child.stderr.on('data', (c) => { err += c })
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, log: out })
        else reject(new Error(err.trim() || `batch terminou com código ${code}`))
      })
      child.on('error', reject)
    })
  })

  ipcMain.handle('media:prepare', async (_event, file) => {
    if (!fs.existsSync(file)) throw new Error('Arquivo não encontrado (foi movido ou removido?).')
    const ext = path.extname(file).toLowerCase()
    const finalPath = DIRECT_EXT.has(ext) ? file : await remux(file)
    return { path: finalPath }
  })

  ipcMain.handle('shell:reveal', (_event, file) => {
    shell.showItemInFolder(file)
  })

  ipcMain.handle('app:cacheInfo', async () => {
    const dir = cacheDir()
    let size = 0
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      size += (await fsp.stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size
    }
    return { dir, size }
  })

  ipcMain.handle('app:clearCache', async () => {
    const dir = cacheDir()
    await fsp.rm(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// evita que um erro de ffmpeg derrube o app inteiro
process.on('uncaughtException', (error) => {
  console.error('[oped] erro não tratado:', error)
})
