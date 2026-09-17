// One structured JSON line per log call, replacing bare console.log/warn strings so a log
// aggregator (or just grep) can filter by level and pick out extra fields reliably.
export function createLogger({ stream = process.stdout, errStream = process.stderr } = {}) {
  function line(level, msg, extra) {
    return JSON.stringify({ at: new Date().toISOString(), level, msg, ...extra });
  }
  return {
    info: (msg, extra) => stream.write(line('info', msg, extra) + '\n'),
    warn: (msg, extra) => errStream.write(line('warn', msg, extra) + '\n'),
    error: (msg, extra) => errStream.write(line('error', msg, extra) + '\n'),
  };
}
