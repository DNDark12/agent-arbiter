import { canonical, digest } from './ledger.js';

const HEX = /^[a-f0-9]{64}$/;
const DOMAIN = 'agent-arbiter.event.v2\0';
const encoder = new TextEncoder();

export async function createSigner(secretHex, expectedAnchor) {
  if (typeof secretHex !== 'string' || !HEX.test(secretHex)) {
    throw new TypeError('Invalid signing secret');
  }
  if (typeof expectedAnchor !== 'string' || !HEX.test(expectedAnchor)) {
    throw new TypeError('Invalid signing anchor');
  }
  const keyId = await digest(secretHex);
  if (keyId !== expectedAnchor) throw new Error('Signing anchor mismatch');
  const bytes = Uint8Array.from(secretHex.match(/../g), byte => parseInt(byte, 16));
  let key, nativeMac;
  try {
    if(typeof crypto.subtle.importKey==='function' && typeof crypto.subtle.sign==='function' && typeof crypto.subtle.verify==='function'){
      key = await crypto.subtle.importKey('raw', bytes,
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
      nativeMac=async data=>new Uint8Array(await crypto.subtle.sign('HMAC',key,data));
    }else{
      // Claude 2.1.325 exposes digest but not importKey/sign. RFC 2104 HMAC
      // over the host's SHA-256; derived pads remain private to this closure.
      // This is not a nonextractable CryptoKey and makes no such claim.
      const inner=new Uint8Array(64).fill(0x36),outer=new Uint8Array(64).fill(0x5c);
      for(let i=0;i<bytes.length;i++){inner[i]^=bytes[i];outer[i]^=bytes[i];}
      nativeMac=async data=>{
        const first=new Uint8Array(64+data.length);first.set(inner);first.set(data,64);
        const hashed=new Uint8Array(await crypto.subtle.digest('SHA-256',first));
        first.fill(0);
        const second=new Uint8Array(96);second.set(outer);second.set(hashed,64);
        const result=new Uint8Array(await crypto.subtle.digest('SHA-256',second));
        second.fill(0);hashed.fill(0);return result;
      };
    }
  } finally {
    bytes.fill(0);secretHex=null;
  }
  return {
    keyId,
    async sign(body) {
      if (typeof body !== 'string') throw new TypeError('Signing body must be text');
      const mac = await nativeMac(encoder.encode(DOMAIN + body));
      return { version: 2, keyId, mac: Array.from(new Uint8Array(mac),
        byte => byte.toString(16).padStart(2, '0')).join('') };
    },
    async verify(body, proof) {
      try {
        if (typeof body !== 'string' || !proof || typeof proof !== 'object' ||
            Array.isArray(proof) || Object.keys(proof).sort().join(',') !== 'keyId,mac,version' ||
            proof.version !== 2 || proof.keyId !== keyId ||
            typeof proof.mac !== 'string' || !HEX.test(proof.mac)) return false;
        const mac = Uint8Array.from(proof.mac.match(/../g), byte => parseInt(byte, 16));
        if(key)return await crypto.subtle.verify('HMAC', key, mac, encoder.encode(DOMAIN + body));
        const expected=await nativeMac(encoder.encode(DOMAIN+body));
        let difference=0;for(let i=0;i<32;i++)difference|=expected[i]^mac[i];
        expected.fill(0);return difference===0;
      } catch {
        return false;
      }
    },
  };
}

export async function signEnvelope(event, signer) {
  const body = canonical(event);
  return { id: event.id, sha256: await digest(body), body, auth: await signer.sign(body) };
}

export async function verifyEnvelope(envelope, signer) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        typeof envelope.id !== 'string' || !HEX.test(envelope.id) ||
        typeof envelope.sha256 !== 'string' || !HEX.test(envelope.sha256) ||
        typeof envelope.body !== 'string') return false;
    const event = JSON.parse(envelope.body);
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        event.id !== envelope.id || canonical(event) !== envelope.body ||
        await digest(envelope.body) !== envelope.sha256) return false;
    return await signer.verify(envelope.body, envelope.auth);
  } catch {
    return false;
  }
}
