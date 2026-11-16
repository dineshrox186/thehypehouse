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
test('public application can be approved and checked in with an Hype House QR token',async()=>{
  const repo=new MemoryRepo(),service=createService(repo),event=EVENTS[0],original={...event};
  event.registrationEnabled=true;
  event.capacity=10;
  event.regOpensAt=new Date(Date.now()-60_000).toISOString();
  event.regClosesAt=new Date(Date.now()+3_600_000).toISOString();
  event.startsAt=new Date(Date.now()+2*86_400_000).toISOString();
  try{
    const application=await service.submitRegistration(event.id,{
      name:'Test Participant',dob:'2000-01-01',email:'participant@example.com',phone:'9876543210',
      ecName:'Emergency Contact',ecPhone:'9876543211',terms:true,mail:true,
      answers:{institution:'Test College',grade:'11',paymentId:'HYPE-UTR-001',instagramUsername:'@participant'}
    });
    assert.match(application.id,/^HH-\d+$/);
    assert.equal(application.status,'pending');
    const admin={id:'00000000-0000-4000-8000-000000000003',email:'admin@hypehouse.test',name:'Admin',passwordHash:'',role:'admin' as const,active:true};
    const reviewed=await service.review(admin,application.id,'approved');
    assert.equal(reviewed.status,'approved');
    const qrToken=String(repo.state.outbox.find(row=>row.template==='approved')?.payload.token ?? '');
    assert.ok(qrToken.length>10);
    assert.equal((await service.checkinLookup(admin,qrToken)).id,application.id);
    const checked=await service.checkIn(admin,application.id);
    assert.equal(checked.participant.status,'approved');
    assert.equal(checked.stats.checkedIn,1);
    await assert.rejects(()=>service.checkIn(admin,application.id),(error:any)=>error.code==='duplicate');
  }finally{Object.assign(event,original);}
});
