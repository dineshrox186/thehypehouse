// Creates or resets the first Hype House admin. There is no public sign-up.
import { randomUUID } from 'node:crypto';
import { buildApp } from './config.ts';
import { hashPassword } from './auth.ts';
const env=process.env,email=(env.ADMIN_EMAIL??'').trim().toLowerCase(),password=env.ADMIN_PASSWORD??'';
if(env.REPO!=='pg'){console.error('Set REPO=pg and DATABASE_URL.');process.exit(1);}
if(!email||password.length<12){console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters). Optional: ADMIN_NAME.');process.exit(1);}
const {repo}=await buildApp(env),existing=await repo.findUserByEmail(email);
await repo.saveUser({id:existing?.id??randomUUID(),email,name:env.ADMIN_NAME||'Hype House Admin',passwordHash:await hashPassword(password),role:'admin',active:true});
console.log(existing?'updated':'created','Hype House admin',email);
process.exit(0);