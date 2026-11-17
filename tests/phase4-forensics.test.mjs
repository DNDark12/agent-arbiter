import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {gitSnapshot,gitHead} from '../extension/hooks/forensics.js';
test('host forensics never executes repository config, filters or PATH commands',async t=>{
 const w=await world(t),head='a'.repeat(40);await fs.mkdir(w.root+'/.git');await fs.mkdir(w.root+'/.git/refs/heads',{recursive:true});
 await fs.writeFile(w.root+'/.git/HEAD','ref: refs/heads/main\n');await fs.writeFile(w.root+'/.git/refs/heads/main',head+'\n');
 let calls=0;w.$.process.run=async()=>{calls++;throw new Error('Untrusted process must never start')};
 assert.equal(await gitHead(w.$,w.root),head);const result=await gitSnapshot(w.$,w.root);
 assert.equal(calls,0);assert.equal(result.head,head);assert.equal(result.status,'partial');assert.equal(result.diffHash,null);
});
