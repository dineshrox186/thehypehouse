import type { Repo, Registration, User, Session, OutboxRow, AuditRow } from './types.ts';
const copy=<T>(value:T):T=>value==null?value:structuredClone(value);
export class MemoryRepo {
 state={regs:new Map<string,Registration>(),users:new Map<string,User>(),sessions:new Map<string,Session>(),outbox:[] as OutboxRow[],audit:[] as AuditRow[],seq:1000,limits:new Map<string,{start:number;count:number}>()};
 chain:Promise<unknown>=Promise.resolve();
 tx<T>(fn:(r:Repo)=>Promise<T>):Promise<T>{const run=async()=>{const snapshot=structuredClone(this.state);try{return await fn(this as unknown as Repo)}catch(e){this.state=snapshot;throw e}};const p=this.chain.then(run,run);this.chain=p.catch(()=>{});return p;}
 async consumeRateLimit(key:string,max:number,windowMs:number){const now=Date.now(),old=this.state.limits.get(key),next=!old||now-old.start>=windowMs?{start:now,count:1}:{start:old.start,count:old.count+1};this.state.limits.set(key,next);return next.count>max;}
 async nextRegistrationId(){return 'HH-'+ ++this.state.seq;}
 async getRegistration(id:string){return copy(this.state.regs.get(id)??null);}
 async listRegistrations(f?:{eventId?:string}){return [...this.state.regs.values()].filter(x=>!f?.eventId||x.eventId===f.eventId).map(copy);}
 async findRegistrationByPaymentId(id:string){const k=id.trim().toUpperCase();return copy([...this.state.regs.values()].find(x=>String(x.answers?.paymentId??'').trim().toUpperCase()===k)??null);}
 async findRegistrationByQrHash(hash:string){return copy([...this.state.regs.values()].find(x=>x.qrTokenHash===hash)??null);}
 async saveRegistration(x:Registration){this.state.regs.set(x.id,copy(x));}
 async findUserByEmail(email:string){return copy([...this.state.users.values()].find(x=>x.email===email.toLowerCase())??null);}
 async getUser(id:string){return copy(this.state.users.get(id)??null);}
 async listUsers(){return [...this.state.users.values()].map(copy);}
 async saveUser(x:User){this.state.users.set(x.id,copy(x));}
 async saveSession(x:Session){this.state.sessions.set(x.id,copy(x));}
 async getSession(id:string){return copy(this.state.sessions.get(id)??null);}
 async deleteSession(id:string){this.state.sessions.delete(id);}
 async deleteSessionsForUser(id:string){for(const [key,x] of this.state.sessions)if(x.userId===id)this.state.sessions.delete(key);}
 async addOutbox(x:OutboxRow){this.state.outbox.push(copy(x));}
 async claimOutbox(limit:number){const now=Date.now(),rows=this.state.outbox.filter(x=>x.status==='queued'&&x.attempts<5&&(!x.scheduledAt||Date.parse(x.scheduledAt)<=now)).slice(0,limit);rows.forEach(x=>x.attempts++);return rows.map(copy);}
 async finishOutbox(id:string,ok:boolean,error?:string){const x=this.state.outbox.find(row=>row.id===id);if(!x)return;if(ok){x.status='sent';x.payload={};x.sentAt=new Date().toISOString();x.lastError=null;}else{x.lastError=error??'error';if(x.attempts>=5)x.status='failed';}}
 async listAudit(f:{action?:string;subjectType?:string;actorId?:string;from?:string;to?:string;limit:number;offset:number}){return this.state.audit.filter(x=>(!f.action||x.action===f.action)&&(!f.subjectType||x.subjectType===f.subjectType)&&(!f.actorId||x.actorId===f.actorId)&&(!f.from||x.at>=f.from)&&(!f.to||x.at<new Date(Date.parse(f.to+'T00:00:00.000Z')+86400000).toISOString())).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id)).slice(f.offset,f.offset+f.limit+1).map(copy);}
 async addAudit(x:AuditRow){this.state.audit.push(copy(x));}
}
