import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { canonical, digest } from '../plugins/agent-arbiter/hooks/ledger.js';
import * as auth from '../plugins/agent-arbiter/hooks/auth.js';

const secret = '0123456789abcdef'.repeat(4);
const otherSecret = 'fedcba9876543210'.repeat(4);
const anchor = await digest(secret);
const event = () => ({ schemaVersion: 1, id: 'a'.repeat(64), projectId: 'b'.repeat(64),
  sessionId: 'session-one', agentId: 'agent-one', kind: 'request', occurredAt: 1234,
  data: { target: 'source.js', approved: false } });
const signer = () => auth.createSigner(secret, anchor);

test('auth module exposes signing and envelope helpers', () => {
  assert.equal(typeof auth.createSigner, 'function');
  assert.equal(typeof auth.signEnvelope, 'function');
  assert.equal(typeof auth.verifyEnvelope, 'function');
});

test('signer validates exact lowercase secret and trusted anchor without leaking secrets', async () => {
  for (const value of ['', secret.toUpperCase(), secret.slice(1), secret + '0', 'g'.repeat(64), null, 42]) {
    await assert.rejects(auth.createSigner(value, anchor), error => {
      assert.equal(error.message.includes(secret), false);
      return error instanceof TypeError;
    });
  }
  for (const value of [null, '', anchor.toUpperCase(), 'c'.repeat(64), secret]) {
    await assert.rejects(auth.createSigner(secret, value), error => {
      assert.equal(error.message.includes(secret), false);
      return error instanceof Error;
    });
  }
});

test('signer uses deterministic domain separated HMAC SHA256 with private nonextractable key', async () => {
  const original = crypto.subtle.importKey;
  let imported;
  crypto.subtle.importKey = async function (...args) {
    imported = await original.apply(this, args);
    return imported;
  };
  let first;
  try { first = await signer(); } finally { crypto.subtle.importKey = original; }
  assert.equal(imported.extractable, false);
  assert.deepEqual(imported.usages, ['sign', 'verify']);
  await assert.rejects(crypto.subtle.exportKey('raw', imported));
  const body = canonical(event());
  const proof = await first.sign(body);
  assert.deepEqual(proof, { version: 2, keyId: anchor, mac: createHmac('sha256',
    Buffer.from(secret, 'hex')).update('agent-arbiter.event.v2\0' + body).digest('hex') });
  assert.deepEqual(await (await signer()).sign(body), proof);
  assert.equal(await first.verify(body, proof), true);
  assert.deepEqual(Object.keys(first).sort(), ['keyId', 'sign', 'verify']);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(Object.values(first).some(value => value instanceof CryptoKey), false);
  await assert.rejects(first.sign({ body }), TypeError);
});

test('proof verification rejects unsigned, malformed, unknown version, wrong key and copied proof', async () => {
  const first = await signer();
  const body = canonical(event());
  const proof = await first.sign(body);
  const other = await auth.createSigner(otherSecret, await digest(otherSecret));
  for (const invalid of [undefined, null, [], {}, { ...proof, version: 1 }, { ...proof, version: 3 },
    { ...proof, keyId: other.keyId }, { ...proof, mac: 'g'.repeat(64) },
    { ...proof, mac: proof.mac.toUpperCase() }, { ...proof, mac: proof.mac.slice(1) },
    { ...proof, mac: '0'.repeat(64) }, { ...proof, extra: true }]) {
    assert.equal(await first.verify(body, invalid), false);
  }
  assert.equal(await other.verify(body, proof), false);
  assert.equal(await first.verify(body + ' ', proof), false);
  assert.equal(await first.verify(null, proof), false);
});

test('signed envelope binds canonical complete event, checksum and identity', async () => {
  const first = await signer();
  const value = event();
  const envelope = await auth.signEnvelope(value, first);
  assert.deepEqual(envelope, { id: value.id, sha256: await digest(canonical(value)),
    body: canonical(value), auth: await first.sign(canonical(value)) });
  assert.equal(await auth.verifyEnvelope(envelope, first), true);
  const replacements = { schemaVersion: 2, id: 'c'.repeat(64), projectId: 'd'.repeat(64),
    sessionId: 'other-session', agentId: null, kind: 'grant', occurredAt: 1235,
    data: { ...value.data, approved: true } };
  for (const [field, replacement] of Object.entries(replacements)) {
    const altered = { ...value, [field]: replacement };
    const body = canonical(altered);
    assert.equal(await auth.verifyEnvelope({ ...envelope, id: altered.id, body,
      sha256: await digest(body) }, first), false, `tampered ${field}`);
  }
  const copied = await auth.signEnvelope({ ...value, id: 'e'.repeat(64) }, first);
  assert.equal(await auth.verifyEnvelope({ ...copied, auth: envelope.auth }, first), false);
});

test('envelope verification rejects noncanonical bodies, mismatched identities and malformed data', async () => {
  const first = await signer();
  const envelope = await auth.signEnvelope(event(), first);
  const spaced = JSON.stringify(event(), null, 2);
  const malformed = [null, [], {}, { ...envelope, auth: undefined },
    { ...envelope, id: 'f'.repeat(64) }, { ...envelope, sha256: '0'.repeat(64) },
    { ...envelope, body: '{' }, { ...envelope, body: null },
    { ...envelope, body: spaced, sha256: await digest(spaced), auth: await first.sign(spaced) }];
  for (const value of malformed) assert.equal(await auth.verifyEnvelope(value, first), false);
  for (const body of ['null', '[]', '42', '"text"']) {
    assert.equal(await auth.verifyEnvelope({ id: envelope.id, body,
      sha256: await digest(body), auth: await first.sign(body) }, first), false);
  }
});

test('digest-only native VM produces the same HMAC without exposing a raw-key export',async()=>{
 const original=globalThis.crypto,descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 const digest=original.subtle.digest.bind(original.subtle);
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest},getRandomValues:original.getRandomValues.bind(original)}});
 try{
  const secret='0b'.repeat(32),anchor=createHash('sha256').update(secret).digest('hex');
  const signer=await auth.createSigner(secret,anchor),body='native digest-only body';
  const proof=await signer.sign(body);
  assert.equal(proof.mac,createHmac('sha256',Buffer.from(secret,'hex')).update('agent-arbiter.event.v2\0'+body).digest('hex'));
  assert.equal(await signer.verify(body,proof),true);assert.equal(await signer.verify(body+'!',proof),false);
  for(const message of ['', 'x'.repeat(63),'x'.repeat(64),'x'.repeat(65),'x'.repeat(4096),'unicode: \u00e9 \u1ea1']){
   const tag=await signer.sign(message);assert.equal(tag.mac,createHmac('sha256',Buffer.from(secret,'hex')).update('agent-arbiter.event.v2\0'+message).digest('hex'));
  }
  assert.equal(JSON.stringify(signer).includes(secret),false);assert.equal(typeof signer.exportKey,'undefined');
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});
