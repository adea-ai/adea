/* A changed file's broad type, from its name, for the file tree and file
 * card icons. Pure; unknown names are `other`. */
import { splitPath } from './diff'

export type FileKind = 'code' | 'data' | 'doc' | 'image' | 'config' | 'other'

const byExtension: Readonly<Record<string, FileKind>> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  rs: 'code',
  go: 'code',
  py: 'code',
  rb: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  cs: 'code',
  css: 'code',
  scss: 'code',
  html: 'code',
  vue: 'code',
  svelte: 'code',
  sh: 'code',
  sql: 'code',
  json: 'data',
  jsonc: 'data',
  csv: 'data',
  xml: 'data',
  lock: 'data',
  md: 'doc',
  mdx: 'doc',
  txt: 'doc',
  rst: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  yml: 'config',
  yaml: 'config',
  toml: 'config',
  ini: 'config',
  env: 'config',
}

const byName: Readonly<Record<string, FileKind>> = {
  dockerfile: 'config',
  makefile: 'config',
  license: 'doc',
}

export function fileKind(path: string): FileKind {
  const name = splitPath(path).name.toLowerCase()
  const named = byName[name]
  if (named) return named
  if (name.startsWith('.') && !name.slice(1).includes('.')) return 'config'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return byExtension[name.slice(dot + 1)] ?? 'other'
}
