import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindCitizen} from '../extension/hooks/citizens.js';
import {digest} from '../extension/hooks/ledger.js';
test('alias and unknown model values never establish a punishable actual-model identity',async()=>{
 const identity={name:'general-purpose',source:'built-in',engineVersion:'2.1.325',provider:null,identityStrength:'engine-version',definitionHash:null};
 for(const model of ['unknown','unspecified','haiku','sonnet','opus','inherit','default','auto','latest','']){
  assert.equal((await bindCitizen(identity,await digest('project'),model)).id,null,model);
 }
 assert.ok((await bindCitizen(identity,await digest('project'),'claude-actual-model-id')).id);
});
