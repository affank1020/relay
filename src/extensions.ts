import { isAbsolute, basename } from 'node:path';

/** Operator-reviewed code, loaded by Pi. Extensions execute with server authority;
 * the browser can inspect this list but cannot install executable code. */
export function configuredExtensions(env:NodeJS.ProcessEnv=process.env) {
  const paths:unknown=JSON.parse(env.RELAY_EXTENSION_PATHS||'[]');
  const tools=(env.RELAY_EXTENSION_TOOLS||'').split(',').map(name=>name.trim()).filter(Boolean);
  if(!Array.isArray(paths)||paths.length>8||paths.some(path=>typeof path!=='string'||!isAbsolute(path))||
      new Set(paths).size!==paths.length||tools.length>32||tools.some(name=>!/^\w[\w-]{0,100}$/.test(name)))
    throw new Error('Invalid reviewed Pi extension configuration');
  return {paths:paths as string[],tools:[...new Set(tools)],names:paths.map(path=>basename(path as string))};
}
