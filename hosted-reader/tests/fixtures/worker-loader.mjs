// Test-only module hooks: run lib/*.ts under plain Node against a fake Workers env.
// `cloudflare:workers` resolves to globalThis.__workerEnv, Next.js request APIs to inert stubs,
// and extensionless relative imports to their .ts file (as Vite resolves them).
import {existsSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
const stubs = {
  'cloudflare:workers': 'export const env = globalThis.__workerEnv;',
  'next/headers': 'export async function headers() { return globalThis.__requestHeaders ?? new Headers(); }',
  'next/navigation': 'export function redirect() { throw new Error("redirect"); }',
};
export async function resolve(specifier, context, next) {
  if (specifier in stubs) return {url: 'stub:' + specifier, shortCircuit: true};
  if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return {url: url.href, shortCircuit: true};
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('stub:')) return {format: 'module', source: stubs[url.slice(5)], shortCircuit: true};
  if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const {source} = await next(url, {...context, format: 'module'});
    // Transform mode: lib/papers.ts uses constructor parameter properties.
    // Vite replaces import.meta.env.DEV at build time; plain Node has no import.meta.env.
    const code = String(source).replaceAll('import.meta.env.DEV', '(globalThis.__viteDev === true)');
    return {format: 'module', source: stripTypeScriptTypes(code, {mode: 'transform', sourceUrl: url}), shortCircuit: true};
  }
  return next(url, context);
}
