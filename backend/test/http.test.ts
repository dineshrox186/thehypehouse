import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http.ts';
import { createService } from '../src/service.ts';
import { MemoryRepo } from '../src/memoryRepo.ts';
import { hashPassword } from '../src/auth.ts';

test('Hype House API enforces auth, CSRF, CORS and has no editable event routes',async t=>{
  const repo=new MemoryRepo();
  const admin={id:randomUUID(),email:'admin@hypehouse.test',name:'Hype House Admin',passwordHash:await hashPassword('secure-hypehouse-password'),role:'admin' as const,active:true};
  await repo.saveUser(admin);
  const server=createServer(createService(repo),{
    corsOrigin:'https://thehypehouse.vercel.app',
    secureCookies:true,
    sharedRateLimit:(key,max,windowMs)=>repo.consumeRateLimit(key,max,windowMs)
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as AddressInfo;
  const base='http://127.0.0.1:'+address.port;

  const health=await fetch(base+'/api/healthz');
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true});

  const publicEvents=await fetch(base+'/api/v1/events');
  assert.equal(publicEvents.status,200);
  assert.ok(Array.isArray((await publicEvents.json() as any).items));

  const removedEvents=await fetch(base+'/api/v1/admin/events');
  assert.equal(removedEvents.status,404);

  const preflight=await fetch(base+'/api/v1/auth/logout',{
    method:'OPTIONS',
    headers:{origin:'https://thehypehouse.vercel.app','access-control-request-method':'POST','access-control-request-headers':'content-type,x-hypehouse-csrf'}
  });
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'https://thehypehouse.vercel.app');
  assert.ok((preflight.headers.get('access-control-allow-headers') ?? '').includes('x-hypehouse-csrf'));

  const login=await fetch(base+'/api/v1/auth/login',{
    method:'POST',
    headers:{origin:'https://thehypehouse.vercel.app','content-type':'application/json'},
    body:JSON.stringify({email:admin.email,password:'secure-hypehouse-password'})
  });
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie') ?? '';
  assert.match(cookie,/hh_session=/);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/Secure/);

  const me=await fetch(base+'/api/v1/auth/me',{headers:{cookie}});
  assert.equal(me.status,200);
  assert.equal((await me.json() as any).role,'admin');

  const blockedLogout=await fetch(base+'/api/v1/auth/logout',{
    method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'
  });
  assert.equal(blockedLogout.status,403);

  const logout=await fetch(base+'/api/v1/auth/logout',{
    method:'POST',headers:{cookie,'content-type':'application/json','x-hypehouse-csrf':'1'},body:'{}'
  });
  assert.equal(logout.status,200);
});
