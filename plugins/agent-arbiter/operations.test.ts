import { test, expect } from 'claude-code/testing'
import { world } from './testing/world'
import { digest } from './hooks/ledger.js'

const projectData = async () => '/fixture-home/.claude/plugins/data/agent-arbiter/v1'

test('native purge from a plugin is refused and deletes nothing',async($,on)=>{
 const w=world(on)
 on('tool.call',()=>({result:'ran'}))
 const base=await projectData(),project=await digest('/fixture')
 w.files.set(base+'/projects/'+project+'/preferences.json',JSON.stringify({rules:[{id:'user:secret',action:'file.write',target:'secrets/**',effect:'deny'}]}))
 expect((await $.tool.call({tool:'Write',agentId:'p-child',tool_use_id:'pw',file_path:'/fixture/secrets/key',content:'x'})).deny).toContain('fine')
 expect([...w.files.keys()].some(key=>key.startsWith(base+'/events/'+project+'/'))).toBe(true)
 // A plugin's command is not the person: it cannot delete Arbiter's records.
 expect((await $.command.run({command:'arbiter',args:'purge all'})).text).toContain('Human composer')
 expect([...w.files.keys()].some(key=>key.startsWith(base+'/events/'+project+'/'))).toBe(true)
 expect((await $.command.run({command:'arbiter',args:'docket'})).text).toContain(' · fine (-10) · ')
})

test('native Arbiter stays inactive on Windows and says so',async($,on)=>{
 world(on,false,[],()=>({}),()=>false,{OS:'Windows_NT',HOME:'C:\\Users\\a'});let ran=0
 on('tool.call',()=>{ran++;return {result:'ran'}})
 expect((await $.command.run({command:'arbiter',args:'status'})).text).toContain('supports macOS and Linux')
 expect((await $.tool.call({tool:'Bash',tool_use_id:'wb',command:'git reset --hard'})).deny).toBeUndefined()
 expect(ran).toBe(1)
})
