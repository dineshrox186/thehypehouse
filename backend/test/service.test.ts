import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepo } from '../src/memoryRepo.ts';
import { createService } from '../src/service.ts';
import { hashPassword } from '../src/auth.ts';
import { EVENTS } from '../src/events.ts';
test('events are source-controlled and not editable through the admin service',async()=>{
  const service=createService(new MemoryRepo()),events=await service.listPublicEvents();
  assert.deepEqual(events.map((event:any)=>event.id),EVENTS.map(event=>event.id));
  assert.equal(events[0].name,'The Hype House Pool Party');
  await assert.rejects(()=>service.submitRegistration('pool-party',{}),(error:any)=>error.code==='closed');
  assert.equal((service as any).createEvent,undefined);
  assert.equal((service as any).updateEvent,undefined);
});
test('login, sessions and staff creation work',async()=>{
  const repo=new MemoryRepo(),service=createService(repo);
  const admin={id:'00000000-0000-4000-8000-000000000001',email:'admin@hypehouse.test',name:'Admin',passwordHash:await hashPassword('long-secure-password'),role:'admin' as const,active:true};
  await repo.saveUser(admin);
  const login=await service.login(admin.email,'long-secure-password');
  assert.equal(login.user.role,'admin');
  assert.equal((await service.authenticate(login.token))?.id,admin.id);
  const staff=await service.createStaff(admin,{email:'staff@hypehouse.test',name:'Staff',password:'another-secure-password',role:'staff'});
  assert.equal(staff.role,'staff');
  assert.equal((await service.listStaff(admin)).length,2);
});
test('unknown event ids cannot be looked up',async()=>{
  const service=createService(new MemoryRepo());
  await assert.rejects(()=>service.getPublicEvent('missing'),(error:any)=>error.code==='not_found');
});
test('parallel approvals cannot exceed hardcoded event capacity',async()=>{
  const repo=new MemoryRepo(),service=createService(repo);
  const event=EVENTS[0],original={...event};
  event.capacity=1;event.registrationEnabled=true;
  try{
    const admin={id:'00000000-0000-4000-8000-000000000002',email:'admin@hypehouse.test',name:'Admin',passwordHash:'',role:'admin' as const,active:true};
    const base=(id:string)=>({id,eventId:event.id,name:id,email:id+'@example.com',phone:'9876543210',dob:null,ecName:null,ecPhone:null,answers:{},consentTerms:true,consentMarketing:true,status:'pending' as const,reason:'',submittedAt:new Date().toISOString(),reviewedBy:null,reviewedAt:null,qrTokenHash:null,checkedInAt:null,checkedInBy:null});
    await repo.saveRegistration(base('HH-2001'));
    await repo.saveRegistration(base('HH-2002'));
    const results=await Promise.allSettled([
      service.review(admin,'HH-2001','approved'),
      service.review(admin,'HH-2002','approved')
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.equal((await repo.listRegistrations({eventId:event.id})).filter(row=>row.status==='approved').length,1);
  }finally{Object.assign(event,original);}
});