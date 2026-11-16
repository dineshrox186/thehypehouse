import { createHash,randomBytes,scrypt,timingSafeEqual } from 'node:crypto';
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const derive=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,32,(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password:string){const salt=randomBytes(16);return 'scrypt$'+salt.toString('base64')+'$'+(await derive(password,salt)).toString('base64');}
export async function verifyPassword(password:string,stored:string){const [scheme,salt,hash]=stored.split('$');if(scheme!=='scrypt'||!salt||!hash)return false;const actual=await derive(password,Buffer.from(salt,'base64')),expected=Buffer.from(hash,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export const DUMMY_HASH=await hashPassword('not-a-real-password');
