// One explicit switch activates the complete Pi execution path for a
// controlled end-to-end rollout. Individual switches remain for compatibility
// with deployments testing the stages separately.
export function piNativeMcpEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.RELAY_PI_FOUNDATION==='1'||env.RELAY_PI_NATIVE_MCP==='1';
}
export function piSubagentsEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.RELAY_PI_FOUNDATION==='1'||env.RELAY_PI_SUBAGENTS==='1';
}
export function piChildMcpEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.RELAY_PI_FOUNDATION==='1'||env.RELAY_PI_CHILD_MCP==='1';
}
