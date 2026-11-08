// Tests must not touch the network or the real policy mode: Jev is exercised by `bun run smoke` instead.
process.env.JEV_MODE = 'off';
// The turn watchdog is silence-based (10 min by default); the runtime test must not wait for that.
process.env.IDLE_TIMEOUT_MS = '120';
