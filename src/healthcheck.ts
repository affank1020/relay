// Relay's Docker healthcheck, authored in TypeScript rather than a JS -e snippet.
const port = Number(process.env.PORT || 8765);
try {
  const response = await fetch('http://127.0.0.1:' + port + '/health', {
    signal: AbortSignal.timeout(3500)
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
