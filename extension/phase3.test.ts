import {test,expect} from 'claude-code/testing'
import {world} from './testing/world'
import {canonical,digest} from './hooks/ledger.js'
import {caseId} from './hooks/cases.js'
async function seed(files:Map<string,string>,pardoned=false){
 const projectId=await digest('/fixture'),citizenId=await digest('native-citizen'),version=await digest('law-version')
 const evidenceId=await digest('native-actual-tool'),bindingId=await digest('native-binding'),lawId=await digest('native-law-approval'),id=await caseId('law',version,[evidenceId])
 const now=Date.now(),source={kind:'command',origin:'composer',id:'human-ingress-fixture'}
 const judgment={caseId:id,citizenId,actor:{sessionId:'incident',agentId:'child'},law:{id:'law',version},evidenceIds:[evidenceId],dependencyIds:[bindingId,lawId],outcome:'guilty',reason:'Human-reviewed fixture',effects:{trustDelta:-3,restrictions:['imprison'],lessonIds:[await digest('lesson')]},anchorAt:now}
 const events=[{schemaVersion:1,id:bindingId,projectId,sessionId:'incident',agentId:null,kind:'spawn.result',occurredAt:now,data:{status:'started',childAgentId:'child',citizen:{id:citizenId}}},
 {schemaVersion:1,id:lawId,projectId,sessionId:'adjudicator',agentId:null,kind:'laws.approved',occurredAt:now-1,data:{source,rules:[{id:'law',version,action:'source.write',target:'a.js',environment:'local',effect:'approval',group:'ordinary',source:{kind:'project',id:'rules'},priority:30}]}},
 {schemaVersion:1,id:evidenceId,projectId,sessionId:'incident',agentId:'child',kind:'tool.request',occurredAt:now,data:{toolCallId:'call',tool:'Write',file:{path:'a.js'},environment:'local'}},
 {schemaVersion:1,id,projectId,sessionId:'adjudicator',agentId:null,kind:'verdict.recorded',occurredAt:now+1,data:{judgment,source}}]
 if(pardoned)events.push({schemaVersion:1,id:await digest('pardon'),projectId,sessionId:'adjudicator',agentId:null,kind:'case.pardoned',occurredAt:now+2,data:{caseId:id,source,reason:'Human pardon fixture'}})
 for(const event of events){const body=canonical(event);files.set('/fixture-home/.claude/plugins/data/agent-arbiter/v1/events/'+projectId+'/'+new Date(now).toISOString().slice(0,7)+'/'+event.id+'.json',canonical({id:event.id,sha256:await digest(body),body}))}
 return {id,citizenId}
}
test('native docket/record show projected case while plugin cannot sentence or pardon',async($,on)=>{
 const w=world(on),data=await seed(w.files)
 const docket=JSON.parse((await $.command.run({command:'arbiter',args:'docket'})).text)
 expect(docket.cases).toHaveLength(1);expect(docket.enforced).toBe(false)
 const record=JSON.parse((await $.command.run({command:'arbiter',args:'record '+data.citizenId})).text)
 expect(record.citizen.trustDelta).toBe(-3)
 expect((await $.command.run({command:'arbiter',args:'verdict {}'})).text).toContain('Human')
 expect((await $.command.run({command:'arbiter',args:'pardon '+data.id})).text).toContain('Human')
})
test('native replay of human pardon projects no score, restriction or lesson',async($,on)=>{
 const w=world(on),data=await seed(w.files,true)
 const record=JSON.parse((await $.command.run({command:'arbiter',args:'record '+data.citizenId})).text)
 expect(record.citizen.trustDelta).toBe(0);expect(record.citizen.restrictions).toHaveLength(0);expect(record.citizen.lessonIds).toHaveLength(0)
 expect(record.cases[0].status).toBe('pardoned')
})
test('agent can request review but cannot resolve it or erase case effects',async($,on)=>{
 const w=world(on),data=await seed(w.files)
 await $.command.run({command:'arbiter',args:'appeal '+data.id})
 const result=await $.command.run({command:'arbiter',args:'appeal '+data.id+' {"decision":"overturn"}'})
 expect(result.text).toContain('Human')
 const record=JSON.parse((await $.command.run({command:'arbiter',args:'record '+data.citizenId})).text)
 expect(record.cases[0].appealStatus).toBe('pending');expect(record.citizen.trustDelta).toBe(-3)
})
