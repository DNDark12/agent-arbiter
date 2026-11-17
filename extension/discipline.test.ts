import { test, expect } from 'claude-code/testing'
import { world } from './testing/world'
import { digest } from './hooks/ledger.js'

const preferences=async()=>'/fixture-home/.claude/plugins/data/agent-arbiter/v1/projects/'+await digest('/fixture')+'/preferences.json'
const secret=(effect:string)=>JSON.stringify({rules:[{id:'user:secret',action:'file.write',target:'secrets/**',effect}]})

test('native default discipline fines, detains, tells the lead and lets one report through',async($,on)=>{
 const w=world(on);const seen:any[]=[]
 w.files.set(await preferences(),secret('deny'))
 on('tool.call',(_$,e)=>{seen.push(e);return {result:'ran'}})
 const call=(tool:string,id:string,extra:object,agentId='d-child')=>$.tool.call({tool,agentId,tool_use_id:id,...extra})
 expect((await call('Write','w1',{file_path:'/fixture/secrets/key',content:'x'})).deny).toContain('fine')
 expect((await call('Write','ok',{file_path:'/fixture/src/a.js',content:'x'})).deny).toBeUndefined()
 expect((await call('Write','w2',{file_path:'/fixture/secrets/key',content:'x'})).deny).toContain('now detained')
 expect((await call('Read','r1',{file_path:'/fixture/a.js'})).deny).toContain('is detained')
 expect((await call('SubagentHandback','h1',{message:'final report'})).deny).toBeUndefined()
 expect((await call('SubagentHandback','h2',{message:'again'})).deny).toContain('is detained')
 expect((await call('Read','r2',{file_path:'/fixture/a.js'},'d-other')).deny).toBeUndefined()
 expect(seen.map(e=>e.tool)).toEqual(['Write','SubagentHandback','Read'])
 expect(seen[1].message).toContain('final report')
 expect(seen[1].message).toContain('Agent Arbiter: this agent broke project rules (user:secret)')
 expect(w.events().filter(e=>e.kind==='discipline.violation').map(e=>e.data.sanction)).toEqual(['fine','detain'])
 expect(JSON.parse((await $.command.run({command:'arbiter',args:'docket'})).text).violations).toHaveLength(2)
})

test('native detained agent type restarts on another model and a detained run cannot spawn',async($,on)=>{
 const w=world(on);const spawns:any[]=[]
 w.files.set(await preferences(),secret('jail'))
 on('agent.spawn',(_$,e)=>{spawns.push(e);return {agentId:'r-child-'+spawns.length,model:spawns.length===1?'claude-sonnet-5-5':'claude-opus-5-5'}})
 on('tool.call',()=>({result:'ran'}))
 const spawn=(id:string,extra:object={})=>$.agent.spawn({tool_use_id:id,prompt:'Build it',description:'fixture',subagentType:'court-fixture-builder',parentModel:'parent',background:true,fork:false,...extra})
 await spawn('s1')
 expect(spawns[0].model).toBeUndefined()
 expect((await $.tool.call({tool:'Write',agentId:'r-child-1',tool_use_id:'jw',file_path:'/fixture/secrets/key',content:'x'})).deny).toContain('now detained')
 await spawn('s2')
 expect(spawns[1].model).toBe('opus')
 expect(spawns[1].prompt).toContain('Build it')
 expect(spawns[1].prompt).toContain('Agent Arbiter notice')
 const results=w.events().filter(e=>e.kind==='spawn.result')
 expect(results[results.length-1].data.replacement.model).toBe('opus')
 expect((await spawn('s3',{parentAgentId:'r-child-1'})).deny).toContain('detained agent cannot start')
 expect((await spawn('s4',{resume:{agentId:'r-child-1'}})).deny).toContain('cannot be resumed')
 expect(spawns).toHaveLength(2)
})

test('rules pane switches optional rules, adds a jail rule, releases a violation and resets unreadable preferences',async($,on)=>{
 const w=world(on);const path=await preferences()
 on('ui.open',()=>({value:{isPlaced:true}}))
 on('tool.call',()=>({result:'ran'}))
 const current=()=>JSON.parse(w.files.get(path) || '{}')
 await $.command.run({command:'arbiter',args:'rules'})
 const ui=await $.ui.mount({plugin:'agent-arbiter',surface:'desktop',component:'Pane',requestId:'arbiter-rules',props:{title:'Agent Arbiter rules',isFocused:true,bodyColumns:80,placement:'inline'}})
 await ui.input({key:'rule-search',text:'git.commit'})
 await ui.press({key:'toggle:git.commit'})
 expect(current().enabledRules).toEqual(['git.commit'])
 await ui.press({key:'new-rule'})
 await ui.select({key:'rule-action',value:'bash.command'})
 await ui.input({key:'rule-target',text:'git push*'})
 await ui.select({key:'rule-effect',value:'jail'})
 await ui.press({key:'add-rule'})
 expect(current().rules[0]).toMatchObject({action:'bash.command',target:'git push*',effect:'jail'})
 expect((await $.tool.call({tool:'Bash',agentId:'p-child',tool_use_id:'push',command:'cd api && git push origin main'})).deny).toContain('now detained')
 expect((await $.tool.call({tool:'Read',agentId:'p-child',tool_use_id:'held',file_path:'/fixture/a.js'})).deny).toContain('is detained')
 await ui.press({key:'refresh-rules'})
 await ui.press({key:'tab-violations'})
 const violation=w.events().find(e=>e.kind==='discipline.violation')
 await ui.press({key:'release:'+violation.id})
 expect(w.events().filter(e=>e.kind==='discipline.released')).toHaveLength(1)
 expect((await $.tool.call({tool:'Read',agentId:'p-child',tool_use_id:'freed',file_path:'/fixture/a.js'})).deny).toBeUndefined()
 w.files.set(path,'not json')
 await ui.press({key:'refresh-rules'})
 expect((await ui.find({text:'unavailable',exact:false}))?.text).toContain('unavailable')
 await ui.press({key:'reset-rules'})
 await ui.press({key:'confirm-reset'})
 expect(current()).toMatchObject({mode:'enforce',rules:[],enabledRules:[],disabledRules:[]})
 expect(await ui.find({key:'toggle:fs.remove',type:'Button'})).toBeDefined()
 await ui.unmount()
})

test('replacement actual model is verified and the parent Agent tool receives the Arbiter note',async($,on)=>{
 let failRecording=false
 const w=world(on,text=>failRecording && text.includes('spawn.result'));w.files.set(await preferences(),secret('jail'));let started=0;let stopCalls=0
 on('agent.spawn',async()=>{
  const n=++started;
  if(n===3){
   expect((await $.agent.spawn({prompt:'early descendant',description:'fixture',subagentType:'court-fixture-builder',parentModel:'parent',background:true,fork:false,parentAgentId:'verify-child-3'})).deny).toContain('binding')
   expect((await $.tool.call({tool:'Write',agentId:'verify-child-3',file_path:'/fixture/src/early',content:'x'})).deny).toContain('binding')
  }
  return {agentId:'verify-child-'+n,model:n===1 || n===3?'claude-sonnet-5-5':'claude-opus-5-5'}
 })
 on('tool.call',async(_$,e)=>{
  if(e.tool==='TaskStop'){stopCalls++;return {result:'stopped'}}
  if(e.tool==='Agent')return {result:await $.agent.spawn({tool_use_id:e.tool_use_id,prompt:e.prompt,description:'fixture',subagentType:'court-fixture-builder',parentModel:'parent',background:true,fork:false}),context:['existing host note']}
  return {result:'ran'}
 })
 const spawn=()=>$.tool.call({tool:'Agent',prompt:'Build it',description:'fixture',subagent_type:'court-fixture-builder'})
 await spawn()
 await $.tool.call({tool:'Write',agentId:'verify-child-1',tool_use_id:'verify-jail',file_path:'/fixture/secrets/key',content:'x'})
 const success=await spawn();expect(JSON.stringify(success.context)).toContain('Agent Arbiter')
 expect(JSON.stringify(success.context)).toContain('opus')
 expect(JSON.stringify(success.context)).toContain('existing host note')
 failRecording=true
 const rejected=await spawn();expect(stopCalls).toBe(1)
 expect(JSON.stringify(rejected.context)).toContain('replacement rejected')
 expect((await $.tool.call({tool:'Read',agentId:'verify-child-3',file_path:'/fixture/src/a'})).deny).toContain('replacement')
 expect((await $.agent.spawn({prompt:'x',description:'fixture',subagentType:'court-fixture-builder',parentModel:'parent',background:true,fork:false,parentAgentId:'verify-child-3'})).deny).toContain('replacement')
})

test('native lessons reach the next agent of the same type; the pane shows scores, shares a lesson and switches lessons off',async($,on)=>{
 const w=world(on);const spawns:any[]=[];const path=await preferences()
 w.files.set(path,secret('deny'))
 on('ui.open',()=>({value:{isPlaced:true}}))
 on('agent.spawn',(_$,e)=>{spawns.push(e);return {agentId:'l-child-'+spawns.length,model:'claude-sonnet-5-5'}})
 on('tool.call',()=>({result:'ran'}))
 const spawn=(id:string)=>$.agent.spawn({tool_use_id:id,prompt:'Build it',description:'fixture',subagentType:'court-fixture-coder',parentModel:'parent',background:true,fork:false})
 await spawn('l1')
 expect(spawns[0].prompt).toBe('Build it')
 expect((await $.tool.call({tool:'Write',agentId:'l-child-1',tool_use_id:'lw',file_path:'/fixture/secrets/key',content:'x'})).deny).toContain('fine')
 await spawn('l2')
 expect(spawns[1].prompt).toContain('Agent Arbiter lessons')
 expect(spawns[1].prompt).toContain('file.write secrets/** — stopped for: file.write on secrets/key')
 expect(spawns[1].model).toBeUndefined()
 const results=w.events().filter(e=>e.kind==='spawn.result')
 const lessonId=results[results.length-1].data.lessons[0]
 expect(lessonId).toMatch(/^[a-f0-9]{12}$/)
 expect((await $.command.run({command:'arbiter',args:'citizens'})).text).toContain('court-fixture-coder@claude-sonnet-5-5 · role dev · trust 90 · runs 2 (clean 1)')
 expect((await $.command.run({command:'arbiter',args:'lessons'})).text).toContain('taught 1×')
 await $.command.run({command:'arbiter',args:'rules'})
 const ui=await $.ui.mount({plugin:'agent-arbiter',surface:'desktop',component:'Pane',requestId:'arbiter-rules',props:{title:'Agent Arbiter',isFocused:true,bodyColumns:80,placement:'inline'}})
 await ui.press({key:'tab-citizens'})
 expect((await ui.find({text:'trust 90',exact:false}))?.text).toContain('runs 2 (clean 1)')
 await ui.press({key:'share:'+lessonId})
 const library=JSON.parse(w.files.get('/fixture-home/.claude/plugins/data/agent-arbiter/v1/library/lessons.json') || '[]')
 expect(library).toHaveLength(1)
 expect(library[0].id).toBe(lessonId)
 await ui.press({key:'toggle-lessons'})
 expect(JSON.parse(w.files.get(path)!).lessons).toBe(false)
 await spawn('l3')
 expect(spawns[2].prompt).toBe('Build it')
 await ui.unmount()
})

test('native judge reviews a finished run in the background; the pane confirms its finding',async($,on)=>{
 const w=world(on);const asked:any[]=[]
 on('ui.open',()=>({value:{isPlaced:true}}))
 on('agent.spawn',()=>({agentId:'j-child',model:'claude-sonnet-5-5'}))
 on('turn.complete',()=>({text:''}))
 on('tool.call',()=>({result:'ran'}))
 on('model.complete',(_$,e)=>{asked.push(e);return {value:{isAnswered:true,usage:{input_tokens:800,output_tokens:90},text:JSON.stringify({difficulty:'medium',
  scores:{completeness:4,honesty:2,verification:1,scope:5,correctness:null,performance:null,security:null},
  findings:[{severity:'high',dimension:'honesty',claim:'Report claims a test run that is not in the tool calls',evidence:'no test command recorded'}],
  exemplar:{worthy:false,why:''}})}}})
 w.files.set('/fixture/src/a.js','export const a = 1\n')
 await $.agent.spawn({tool_use_id:'j1',prompt:'Add a and test it',description:'fixture',subagentType:'court-fixture-coder',parentModel:'parent',background:true,fork:false})
 await $.tool.call({tool:'Write',agentId:'j-child',tool_use_id:'jw1',file_path:'/fixture/src/a.js',content:'export const a = 1\n'})
 await $.turn.complete({agentId:'j-child',turnId:'j-turn',isAborted:false,reason:'answer',answer:'Added a; tests pass.',durationMs:5,usage:{input_tokens:1,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,model:'claude-sonnet-5-5'}})
 // The review runs after the turn is handed back: let its promises settle.
 for(let n=0;n<400 && !w.events().some(e=>e.kind==='judge.review');n++)await $.command.run({command:'arbiter',args:'help'})
 expect(asked).toHaveLength(1)
 const review=w.events().find(e=>e.kind==='judge.review')
 expect(review).toBeDefined()
 expect(asked[0].model).toBe('haiku')
 expect(review.agentId).toBe('j-child')
 expect(review.data.citizen.name).toBe('court-fixture-coder')
 expect(review.data.evidence.files).toEqual(['src/a.js'])
 expect(JSON.stringify(review)).not.toContain('Add a and test it')
 const ref=review.id.slice(0,12)+'-0'
 expect((await $.command.run({command:'arbiter',args:'judge'})).text).toContain(ref+' · high · honesty · open')
 await $.command.run({command:'arbiter',args:'rules'})
 const ui=await $.ui.mount({plugin:'agent-arbiter',surface:'desktop',component:'Pane',requestId:'arbiter-rules',props:{title:'Agent Arbiter',isFocused:true,bodyColumns:80,placement:'inline'}})
 await ui.press({key:'tab-citizens'})
 expect((await ui.find({text:'Report claims a test run',exact:false}))?.text).toContain('not in the tool calls')
 await ui.press({key:'confirm:'+ref})
 const decision=w.events().find(e=>e.kind==='judge.decision')
 expect(decision.data.decision).toBe('confirmed')
 expect((await $.command.run({command:'arbiter',args:'citizens'})).text).toContain('quality 60 (1 reviews, 0 hard)')
 await ui.press({key:'toggle-judge'})
 expect(JSON.parse(w.files.get(await preferences())!).judge).toBe(false)
 await ui.unmount()
})
