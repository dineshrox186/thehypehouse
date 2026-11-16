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