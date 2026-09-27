const net = require('node:net');

/**
 * Minimal clamd client using the INSTREAM command: the file is streamed in length-prefixed
 * chunks and clamd answers "stream: OK" or "stream: <Signature> FOUND".
 */
function createScanner({ host, port, timeoutMs = 30_000, chunkSize = 64 * 1024 }) {
  function scan(buffer) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let response = '';
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('ClamAV scan timed out')));
      socket.on('error', reject);
      socket.on('data', (d) => { response += d.toString(); });
      socket.on('end', () => {
        const text = response.replace(/\0/g, '').trim();
        if (text.endsWith('OK')) return resolve({ clean: true });
        const match = /stream: (.+) FOUND/.exec(text);
        if (match) return resolve({ clean: false, signature: match[1] });
        return reject(new Error(`Unexpected ClamAV response: ${text}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < buffer.length; offset += chunkSize) {
          const chunk = buffer.subarray(offset, offset + chunkSize);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
  }

  return { scan };
}

/** Used when SCAN_ENABLED=false (e.g. tests); never use in production. */
const noopScanner = { scan: async () => ({ clean: true, skipped: true }) };

module.exports = { createScanner, noopScanner };
