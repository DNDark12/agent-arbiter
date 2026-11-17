import { test, expect } from 'claude-code/testing'
import { world } from './testing/world'
import { canonical, digest } from './hooks/ledger.js'

test('native plugin command origin cannot mint authority or disable Arbiter', async ($, on) => {
 const w=world(on)
 const grant=await $.command.run({command:'arbiter',args:'grant {"action":"git.commit","target":"main","environment":"local"}'})
 expect(grant.text).toContain('Human')
 expect((await $.command.run({command:'arbiter',args:'off'})).text).toContain('Human')
 expect(w.events().filter(e=>e.kind==='grant.created' || e.kind==='court.mode')).toHaveLength(0)
})

test('native check reuses persisted trusted grant and never dispatches a tool', async ($, on) => {
 const w=world(on)
 const projectId=await digest('/fixture')
 const now=Date.now()
 const grant={id:'fixture-grant',action:'git.commit',target:'main',environment:'local',projectId,sessionId:'session-native',scope:{kind:'session',id:'session-native'},agentId:null,expiresAt:now+60000,source:{kind:'command',origin:'composer',id:'fixture-command'}}
 const event={schemaVersion:1,id:await digest('trusted-grant-fixture'),projectId,sessionId:'session-native',agentId:null,kind:'grant.created',occurredAt:now,data:{grant}}
 const body=canonical(event)
 const path='/fixture-home/.claude/plugins/data/agent-arbiter/v1/events/'+projectId+'/'+new Date(now).toISOString().slice(0,7)+'/'+event.id+'.json'
 w.files.set(path,canonical({id:event.id,sha256:await digest(body),body}))
 const input={action:'git.commit',target:'main',environment:'local',requestedApproval:true}
 for(let i=0;i<2;i++) {
  const result=await $.command.run({command:'arbiter',args:'check '+JSON.stringify(input)})
  expect(JSON.parse(result.text).decision.outcome).toBe('allow')
  expect(JSON.parse(result.text).executed).toBe(false)
 }
 const wrong=await $.command.run({command:'arbiter',args:'check '+JSON.stringify({...input,environment:'production'})})
 expect(JSON.parse(wrong.text).decision.outcome).toBe('ask')
 expect(w.events().filter(e=>e.kind==='grant.created')).toHaveLength(1)
 expect(w.events().filter(e=>e.kind==='tool.request')).toHaveLength(0)
})

test('native laws exposes hashed source and enforcement stays unavailable', async ($, on) => {
 world(on)
 const laws=JSON.parse((await $.command.run({command:'arbiter',args:'laws'})).text)
 expect(laws.rules.length).toBeGreaterThan(0)
 expect(laws.rules.every(r=>r.source.kind==='builtin' && /^[a-f0-9]{64}$/.test(r.version))).toBe(true)
 expect((await $.command.run({command:'arbiter',args:'mode enforce'})).text).toContain('Human')
})
