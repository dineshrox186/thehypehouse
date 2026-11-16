import type { IncomingMessage,ServerResponse } from 'node:http';
import { buildApp } from './config.ts';
import { createHandler } from './http.ts';
type Handler=(request:IncomingMessage,response:ServerResponse)=>Promise<void>;
let ready:Promise<Handler>|undefined;
export function handler(request:IncomingMessage,response:ServerResponse):Promise<void>{
  const current=ready??(ready=buildApp(process.env).then(app=>createHandler(app.svc,app.http)).catch(error=>{ready=undefined;throw error;}));
  return current.then(fn=>fn(request,response));
}