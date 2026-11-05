import { execFile, spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

const stopping = new WeakMap()

/** Give the CLI and its tools a process group owned by this plugin. */
export function spawnAgent(argv, options) {
  return spawn(argv[0], argv.slice(1), { ...options, detached: process.platform !== 'win32', windowsHide: true })
}

export function signalAgent(child, signal = 'SIGTERM') {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function groupAlive(child) {
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function processTable() {
  const proc = process.platform === 'linux' ? await readdir('/proc').catch(() => undefined) : undefined
  if (proc) {
    const entries = await Promise.all(proc.filter((name) => /^\d+$/.test(name)).map(async (name) => {
      try {
        const stat = await readFile(`/proc/${name}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return [Number(name), { parent: Number(fields[1]), group: Number(fields[2]), started: fields[19], zombie: fields[0] === 'Z' }]
      } catch { return undefined } // Processes may exit during the snapshot.
    }))
    return new Map(entries.filter(Boolean))
  }
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const entries = error ? [] : stdout.trim().split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        return match ? [[Number(match[1]), { parent: Number(match[2]), group: Number(match[3]), started: match[4] }]] : []
      })
      resolve(new Map(entries))
    })
  })
}

function addDescendants(owned, table) {
  let added
  do {
    added = false
    for (const [pid, info] of table) {
      if (!owned.has(pid) && owned.has(info.parent) && owned.get(info.parent).started === table.get(info.parent)?.started) {
        owned.set(pid, info)
        added = true
      }
    }
  } while (added)
}

function signalDescendants(owned, table, signal, group) {
  for (const [pid, info] of owned) {
    // A PID can be reused during the grace period. Match its process identity.
    if (table.get(pid)?.started !== info.started || table.get(pid)?.zombie || table.get(pid)?.group === group) continue
    try { process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

/**
 * Stop the owned group, including tools that outlive its leader. Bound the wait
 * for inherited pipes too: a CLI can launch a tool in a separate process group.
 */
export function stopAgent(child, graceMs = 3000) {
  if (stopping.has(child)) return stopping.get(child)
  const done = (async () => {
    // Snapshot before stopping the leader: tools can create their own groups,
    // and become reparented as soon as the CLI exits.
    const table = process.platform === 'win32' ? new Map() : await processTable()
    const owned = new Map()
    if (table.has(child.pid)) owned.set(child.pid, table.get(child.pid))
    addDescendants(owned, table)
    return new Promise((resolve, reject) => {
      let timer
      let finished = false
      const finish = (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.removeListener('close', onClose)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (error) reject(error)
        else resolve()
      }
      const onClose = () => {
        processTable().then((current) => {
          const alive = [...owned].some(([pid, info]) => current.get(pid)?.started === info.started && !current.get(pid)?.zombie)
          if (!groupAlive(child) && !alive) finish()
        }).catch(finish)
      }
      if (!child.pid) return finish()
      if (process.platform === 'win32') {
        // kill() only stops the leader on Windows; taskkill owns the tree walk.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('error', () => { child.kill('SIGKILL'); finish() })
        killer.once('exit', () => finish())
        timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); finish() }, graceMs)
      } else {
        child.once('close', onClose)
        try {
          signalAgent(child)
          signalDescendants(owned, table, 'SIGTERM', child.pid)
        } catch (error) { finish(error); return }
        timer = setTimeout(() => {
          processTable().then((current) => {
            if (finished) return
            addDescendants(owned, current)
            signalAgent(child, 'SIGKILL')
            signalDescendants(owned, current, 'SIGKILL', child.pid)
            finish()
          }).catch(finish)
        }, graceMs)
        if (child.exitCode !== null || child.signalCode !== null) onClose()
      }
    })
  })()
  stopping.set(child, done)
  return done
}
