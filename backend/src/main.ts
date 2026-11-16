import { createServer } from './http.ts';
import { buildApp } from './config.ts';
import { seedDev } from './seed.ts';
const env=process.env;
const app=await buildApp({SECURE_COOKIES:'0',...env});
if(env.SEED==='1'){
  const seeded=await seedDev(app.repo,env.SEED_PASSWORD||undefined);
  console.log('[seed] demo users '+seeded.users.join(', ')+' password: '+seeded.password);
}
setInterval(()=>app.runOutbox().catch(error=>console.error('[outbox]',error)),5000).unref();
const port=Number(env.PORT)||8787;
createServer(app.svc,app.http).listen(port,()=>console.log('[thehypehouse] API on :'+port+' (repo='+(env.REPO??'memory')+')'));