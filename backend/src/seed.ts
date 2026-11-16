// Development-only demo accounts. Event information is never seeded into a database.
import { randomUUID,randomBytes } from 'node:crypto';
import type { Repo } from './types.ts';
import { hashPassword } from './auth.ts';
export async function seedDev(repo:Repo,password=randomBytes(9).toString('base64url')){
  const create=async(email:string,name:string,role:'organiser'|'staff')=>repo.saveUser({id:randomUUID(),email,name,passwordHash:await hashPassword(password),role,active:true});
  await create('organiser@hypehouse.test','Demo Organiser','organiser');
  await create('staff@hypehouse.test','Demo Staff','staff');
  return {password,users:['organiser@hypehouse.test','staff@hypehouse.test']};
}