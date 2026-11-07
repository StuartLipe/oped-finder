'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { analyzeFiles } = require('./analyzer.cjs')

analyzeFiles(workerData.files, {
  onProgress: (payload) => parentPort.postMessage({ type: 'progress', payload }),
})
  .then((result) => parentPort.postMessage({ type: 'result', payload: result }))
  .catch((error) => parentPort.postMessage({ type: 'error', message: error?.message || String(error) }))
