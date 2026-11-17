import {test,expect} from 'claude-code/testing'
import {world} from './testing/world'

test('native public profile is read-only and SDK cannot bootstrap, probe or activate',async($,on)=>{
 world(on)
 const profile=JSON.parse((await $.command.run({command:'arbiter',args:'runtime profile'})).text)
 expect(profile.applied).toBe(false);expect(profile.settings.sandbox.failIfUnavailable).toBe(true)
 expect(profile.settings.permissions.deny.includes('Grep')).toBe(true)
 for(const args of ['runtime bootstrap','runtime probe','mode enforce {}']){
  expect((await $.command.run({command:'arbiter',args})).text).toContain('Human')
 }
})

test('native default ignores broken optional anchor and permits normal Read Write Bash',async($,on)=>{
 const w=world(on,false,[],()=>({env:{AGENT_ARBITER_ANCHOR:'a'.repeat(64)}}));let ran=0
 on('tool.call',()=>{ran++;return {result:'ordinary result'}})
 for(const e of [{tool:'Read',file_path:'/fixture/a.js'},{tool:'Write',file_path:'/fixture/a.js',content:'x'},{tool:'Bash',command:'node --test'}]){
  expect((await $.tool.call(e)).deny).toBeUndefined()
 }
 expect(ran).toBe(3)
 expect(w.events().filter(e=>e.kind==='verdict.recorded')).toHaveLength(0)
})

test('native unavailable approval refuses destructive Bash before execution',async($,on)=>{
 world(on);let ran=0
 on('tool.call',{tool:'Bash'},()=>{ran++;return {result:'must not execute'}})
 const result=await $.tool.call({tool:'Bash',command:'git reset --hard HEAD'})
 expect(ran).toBe(0);expect(result.deny).toContain('approval declined')
})

test('native ledger IO failure permits ordinary file edits and preserves protected path handling',async($,on)=>{
 world(on,false,[],()=>({}),()=>true);let ran=0
 on('tool.call',{tool:'Write'},()=>{ran++;return {result:'normal result'}})
 expect((await $.tool.call({tool:'Write',file_path:'/fixture/a.js',content:'x'})).deny).toBeUndefined()
 // Claude settings ask (nobody answers here); Arbiter data is denied by rule.
 expect((await $.tool.call({tool:'Write',file_path:'/fixture/.claude/settings.json',content:'x'})).deny).toContain('approval declined or unavailable')
 expect((await $.tool.call({tool:'Write',file_path:'/fixture-home/.claude/plugins/data/agent-arbiter/v1/events/x.json',content:'x'})).deny).toContain('denied by rule: file.arbiter')
 expect(ran).toBe(1)
})
