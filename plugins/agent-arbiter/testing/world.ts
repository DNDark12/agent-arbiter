import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export function world(on: On, failWrites: boolean | ((text: string) => boolean) = false, transcript: unknown = [], settings: () => Record<string, unknown> = () => ({}), failLists: () => boolean = () => false, env: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const warnings: string[] = []
  mock.store(on)
  const config = new Map<string, string | boolean>([['agent-arbiter.enabled',true],['agent-arbiter.language','en']])
  on('config.list',()=>({value:[...config].map(([key,value])=>({key,value,label:key,kind:typeof value==='boolean'?'boolean' as const:'choice' as const,isLocked:false,provider:{plugin:'agent-arbiter',tier:'user' as const},...(typeof value==='string'?{options:['auto','en','vi']}:{})}))}))
  on('config.set',(_$,e)=>{ config.set(e.key,e.value as string | boolean); return {value:e.value} })
  on('ui.status',()=>({value:undefined}))
  on('settings.read',()=>({value:settings()}))
  on('tool.list',()=>({value:[{name:'Bash',description:'fixture Bash',mcp:false}]}))
  on('session.id', () => ({ value: 'session-native' }))
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/fixture' }))
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  on('session.model', () => ({ value: 'resolved-model' }))
  on('session.turns', () => ({ value: 2 }))
  on('session.messages', () => ({ value: transcript }))
  on('env.get', (_$, e) => ({ value: Object.hasOwn(env, e.name) ? env[e.name] : e.name === 'HOME' ? '/fixture-home' : undefined }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(e.path + '/')) }))
  on('fs.write', (_$, e) => {
    if (typeof failWrites==='function'?failWrites(e.text):failWrites) return { deny: 'fixture disk unavailable' }
    files.set(e.path, e.text); return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', (_$, e) => {
    if(failLists())return {deny:'fixture policy IO failure'}
    const entries = new Map()
    for (const [path, text] of files) {
      if (!path.startsWith(e.path + '/')) continue
      const rest = path.slice(e.path.length + 1)
      const name = rest.split('/')[0]
      entries.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file', size: text.length, mtimeMs: 0, isLink: false })
    }
    return { value: [...entries.values()] }
  })
  on('fs.stat', (_$, e) => ({ value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', (_$, e) => {
    let exitCode = 0
    let stdout = ''
    if (e.argv[0] === '/bin/ln') {
      if (files.has(e.argv[2])) exitCode = 1
      else files.set(e.argv[2], files.get(e.argv[1]) ?? '')
    } else if (e.argv[0] === '/bin/mv') {files.set(e.argv[3],files.get(e.argv[2]) ?? '');files.delete(e.argv[2])}
    else if (e.argv[0] === '/bin/rm') {
      const recursive = e.argv.slice(1).some(arg => /^-[a-z]*r/.test(arg))
      for (const path of e.argv.slice(1)) if (!path.startsWith('-')) {
        files.delete(path)
        if (recursive) for (const key of [...files.keys()]) if (key.startsWith(path + '/')) files.delete(key)
      }
    }
    else if (e.argv[0] === 'git') {
      if (e.argv.includes('rev-parse')) stdout = 'fixture-head\n'
      else if (e.argv.includes('status')) stdout = ' M src/file.js\0'
    } else throw new Error('Unexpected process')
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', (_$, e) => { warnings.push(JSON.stringify(e)); return { value: undefined } })
  return {
    files, warnings,
    events() { return [...files.entries()].filter(([p]) => /\/[a-f0-9]{64}\.json$/.test(p) && p.includes('/events/')).map(([,s]) => JSON.parse(JSON.parse(s).body)) },
  }
}

