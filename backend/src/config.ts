import { MemoryRepo } from './memoryRepo.ts';
import { createService } from './service.ts';
import { ConsoleMailer,ResendMailer,processOutbox,render } from './mailer.ts';
import { turnstileVerifier } from './turnstile.ts';
import { EVENTS } from './events.ts';
import type { Repo } from './types.ts';
import type { HttpOpts } from './http.ts';
type Env=Record<string,string|undefined>;
export async function buildApp(env:Env){
  let repo:Repo;
  if(env.REPO==='pg'){
    if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required when REPO=pg');
    const {createPgRepo}=await import('./pgRepo.ts');
    repo=await createPgRepo(env.DATABASE_URL,{ssl:env.DATABASE_SSL!=='disable',max:Number(env.PG_POOL_MAX)||3});
  }else{
    if(env.NODE_ENV==='production')throw new Error('REPO=pg and DATABASE_URL are required in production');
    repo=new MemoryRepo() as unknown as Repo;
  }
  if(env.NODE_ENV==='production'){
    const missing=['CORS_ORIGIN','TURNSTILE_SECRET','RESEND_API_KEY','MAIL_FROM','CRON_SECRET'].filter(key=>!env[key]);
    if(env.TRUST_PROXY!=='1')missing.push('TRUST_PROXY=1');
    if(missing.length)throw new Error('Missing required production environment variables: '+missing.join(', '));
    if(env.SECURE_COOKIES==='0')throw new Error('SECURE_COOKIES=0 is not allowed in production');
  }
  if(env.RESEND_API_KEY&&!env.MAIL_FROM)throw new Error('MAIL_FROM is required when RESEND_API_KEY is set');
  const mailer=env.RESEND_API_KEY?new ResendMailer(env.RESEND_API_KEY,env.MAIL_FROM!):new ConsoleMailer();
  const service=createService(repo),mailOptions={eventTimezone:env.EVENT_TIMEZONE||'Asia/Kolkata'};
  const runOutbox=()=>processOutbox(repo,mailer,25,mailOptions);
  const kick=async()=>{let timeout:any;try{await Promise.race([runOutbox(),new Promise(resolve=>{timeout=setTimeout(resolve,4000);})]);}finally{clearTimeout(timeout);}};
  const http:HttpOpts={
    corsOrigin:env.CORS_ORIGIN,secureCookies:env.SECURE_COOKIES!=='0',trustProxy:env.TRUST_PROXY==='1',
    sameSite:env.COOKIE_SAME_SITE==='None'||env.COOKIE_SAME_SITE==='Strict'?env.COOKIE_SAME_SITE:'Lax',
    captcha:env.TURNSTILE_SECRET?turnstileVerifier(env.TURNSTILE_SECRET):undefined,
    afterMail:kick,cronSecret:env.CRON_SECRET,runOutbox,
    sendReviewMail:async(email,template)=>{
      const event=EVENTS[0];if(!event)throw new Error('No hardcoded Hype House events configured');
      const at=new Date().toISOString();
      const reg={id:'HH-TEST',eventId:event.id,name:'there',email,phone:'',dob:null,ecName:null,ecPhone:null,answers:{},consentTerms:true,consentMarketing:true,status:template==='approved'?'approved' as const:template==='rejected'?'rejected' as const:'pending' as const,reason:'',submittedAt:at,reviewedBy:null,reviewedAt:null,qrTokenHash:null,checkedInAt:null,checkedInBy:null};
      const row={id:'test-'+crypto.randomUUID(),registrationId:reg.id,template,payload:{},status:'queued' as const,attempts:0,lastError:null,createdAt:at,sentAt:null,scheduledAt:null};
      await mailer.send(await render(row,reg,event,mailOptions));
    },
    sharedRateLimit:(key,max,windowMs)=>repo.consumeRateLimit(key,max,windowMs),
    log:entry=>console.log(JSON.stringify(entry))
  };
  return {repo,svc:service,http,mailer,runOutbox};
}