require('dotenv').config()
const net = require('net')

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err)
})

const remotehost = process.env.REMOTE_HOST
const remoteport = parseInt(process.env.REMOTE_PORT || '0', 10)
const password = process.env.REMOTE_PASSWORD
const localhost = process.env.LOCAL_HOST || '0.0.0.0'
const localport = parseInt(process.env.LOCAL_PORT || '2020', 10)

if (!localhost || !localport || !remotehost || !remoteport || !password) {
  console.error('Error: check your arguments and try again!')
  process.exit(1)
}

function replaceHandshakeHeaders(buf, opts) {
  // only attempt text replacement for probable HTTP handshake
  const str = buf.toString('utf8')
  if (!str.startsWith('GET ')) return buf // not an HTTP GET handshake
  let out = str

  // Normalize line endings
  // Replace Host header
  out = out.replace(/(^Host:\s*)([^\r\n]+)/im, `$1${opts.targetHost}`)

  // Replace Origin header if present (some servers check Origin)
  if (opts.origin) {
    if (/^Origin:/im.test(out)) {
      out = out.replace(/(^Origin:\s*)([^\r\n]+)/im, `$1${opts.origin}`)
    } else {
      // insert Origin header after Host (if Host existed), keeping minimal change
      out = out.replace(/(Host:.*\r\n)/i, `$1Origin: ${opts.origin}\r\n`)
    }
  }

  // Some servers expect a specific User-Agent — optional tweak
  if (opts.userAgent) {
    if (/^User-Agent:/im.test(out)) {
      out = out.replace(/(^User-Agent:\s*)([^\r\n]+)/im, `$1${opts.userAgent}`)
    } else {
      out = out.replace(/(Host:.*\r\n)/i, `$1User-Agent: ${opts.userAgent}\r\n`)
    }
  }

  return Buffer.from(out, 'utf8')
}

const server = net.createServer((localsocket) => {
  const remotesocket = new net.Socket()

  remotesocket.setKeepAlive(true)
  remotesocket.connect(remoteport, remotehost, () => {
    // optional: you can send any auth/password here if needed by remote
    // e.g., remotesocket.write(password + '\n')
  })

  localsocket.on('connect', () => {
    console.log('>>> connection from %s:%d',
      localsocket.remoteAddress,
      localsocket.remotePort)
  })

  localsocket.on('data', (data) => {
    console.log('%s:%d - writing data to remote',
      localsocket.remoteAddress,
      localsocket.remotePort
    )
    // debug small chunk text (avoid logging binary frames fully)
    if (data && data.length < 2000) {
      try { console.log('localsocket-data (peek): %s', data.toString('utf8')) } catch(e) {}
    } else {
      console.log('localsocket-data: <binary %d bytes>', data.length)
    }

    // If this looks like a WebSocket HTTP handshake, rewrite Host/Origin headers
    const newData = replaceHandshakeHeaders(data, {
      targetHost: remotehost,
      origin: `https://${remotehost}`, // try https origin; some expect https
      userAgent: 'miner-proxy/1.0'
    })

    const flushed = remotesocket.write(newData)
    if (!flushed) {
      console.log(' remote not flushed; pausing local')
      localsocket.pause()
    }
  })

  remotesocket.on('data', (data) => {
    console.log('%s:%d - writing data to local',
      localsocket.remoteAddress,
      localsocket.remotePort
    )
    if (data && data.length < 2000) {
      try { console.log('remotesocket-data (peek): %s', data.toString('utf8')) } catch(e) {}
    } else {
      console.log('remotesocket-data: <binary %d bytes>', data.length)
    }

    const flushed = localsocket.write(data)
    if (!flushed) {
      console.log(' local not flushed; pausing remote')
      remotesocket.pause()
    }
  })

  localsocket.on('drain', () => {
    console.log('%s:%d - resuming remote',
      localsocket.remoteAddress,
      localsocket.remotePort
    )
    remotesocket.resume()
  })

  localsocket.on('close', (had_err) => {
    console.log('%s:%d - closing remote',
      localsocket.remoteAddress,
      localsocket.remotePort
    )
    try { remotesocket.end() } catch (e) {}
  })

  remotesocket.on('close', (had_err) => {
    console.log('%s:%d - closing local',
      localsocket.remoteAddress,
      localsocket.remotePort
    )
    try { localsocket.end() } catch (e) {}
  })

  localsocket.on('error', (err) => {
    console.error('localsocket error:', err && err.message)
    try { remotesocket.destroy() } catch(e) {}
  })
  remotesocket.on('error', (err) => {
    console.error('remotesocket error:', err && err.message)
    try { localsocket.destroy() } catch(e) {}
  })
})

server.listen(localport, localhost, () => {
  console.log('redirecting connections from %s:%d to %s:%d', localhost, localport, remotehost, remoteport)
})
