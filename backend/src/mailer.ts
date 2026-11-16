import type { Repo, OutboxRow, Registration, EventRow } from './types.ts';
import { getEvent } from './events.ts';
import * as QRCode from 'qrcode';
export interface MailAttachment { filename:string; contentType:string; content:Buffer }
export interface Mail { to:string; subject:string; text:string; html:string; attachments?:MailAttachment[]; key?:string }
export interface Mailer { send(mail:Mail):Promise<void> }
export class ConsoleMailer implements Mailer {
  sent:Mail[]=[]; quiet=false;
  async send(mail:Mail){this.sent.push(mail);if(!this.quiet)console.log('[mail] to='+mail.to+' subject="'+mail.subject+'"');}
}
export class ResendMailer implements Mailer {
  apiKey:string;
  from:string;
  fetchImpl:typeof fetch;
  constructor(apiKey:string,from:string,fetchImpl:typeof fetch=(...args)=>fetch(...args)){
    this.apiKey=apiKey;
    this.from=from;
    this.fetchImpl=fetchImpl;
  }
  async send(mail:Mail){
    const attachments=mail.attachments?.map(item=>({filename:item.filename,content_type:item.contentType,content:item.content.toString('base64')}));
    const response=await this.fetchImpl('https://api.resend.com/emails',{
      method:'POST',
      headers:{authorization:'Bearer '+this.apiKey,'content-type':'application/json',...(mail.key?{'idempotency-key':mail.key}:{})},
      body:JSON.stringify({from:this.from,to:[mail.to],subject:mail.subject,html:mail.html,text:mail.text,...(attachments?.length?{attachments}:{})})
    });
    if(!response.ok)throw new Error('Resend '+response.status+': '+(await response.text().catch(()=>'')).slice(0,200));
  }
}
const escapeHtml=(value:unknown)=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const formatWhen=(value:string,timeZone:string)=>{
  try{return new Intl.DateTimeFormat('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',timeZone}).format(new Date(value));}
  catch{return 'To be announced';}
};
export async function render(row:OutboxRow,reg:Registration,event:EventRow,options:{eventTimezone?:string;ticketUrl?:string}={}):Promise<Mail>{
  const date=event.startsAt?formatWhen(event.startsAt,options.eventTimezone??'Asia/Kolkata'):'To be announced';
  const token=typeof row.payload.token==='string'?row.payload.token:'';
  const attachQr=Boolean(token&&(row.template==='approved'||row.template==='event_tomorrow'));
  const subjects:Record<OutboxRow['template'],string>={
    received:'Application received — '+event.name,
    approved:'Registration confirmed — '+event.name,
    rejected:'Application update — '+event.name,
    event_tomorrow:'Your event is coming up — '+event.name,
    thank_you:'Thank you for joining us — '+event.name
  };
  const heading=row.template==='received'?'We received your application':row.template==='approved'?'You’re confirmed':row.template==='rejected'?'An update on your application':row.template==='event_tomorrow'?'See you soon':'Thank you for being there';
  const intro=row.template==='received'
    ?'Hi '+escapeHtml(reg.name)+', your application is with our team. We’ll email you when there is an update.'
    :row.template==='rejected'
      ?'Unfortunately, your application was not approved. Reason: '+escapeHtml(String(row.payload.reason??''))
      :'Hi '+escapeHtml(reg.name)+', we look forward to seeing you at The Hype House.';
  const qrNote=attachQr?'<p style="color:#ded7df">Your entry QR ticket is attached. Keep it ready for check-in.</p>':'';
  const rows='<tr><td style="color:#b7a8b7;padding:8px 12px 8px 0">Event</td><td style="color:#fff;padding:8px 0">'+escapeHtml(event.name)+'</td></tr>'+
    '<tr><td style="color:#b7a8b7;padding:8px 12px 8px 0">Date</td><td style="color:#fff;padding:8px 0">'+escapeHtml(date)+'</td></tr>'+
    '<tr><td style="color:#b7a8b7;padding:8px 12px 8px 0">Venue</td><td style="color:#fff;padding:8px 0">'+escapeHtml(event.venue||'To be announced')+'</td></tr>';
  const html='<!doctype html><html><body style="margin:0;background:#100b12;font-family:Arial,sans-serif;color:#fff;padding:28px 12px"><div style="max-width:600px;margin:auto;background:#19121b;border:1px solid #493246;border-radius:18px;overflow:hidden"><header style="padding:30px 28px;background:linear-gradient(120deg,#35162d,#170f1a)"><div style="font-size:12px;letter-spacing:4px;color:#f0a4cf;font-weight:bold">THE HYPE HOUSE</div><h1 style="font-size:25px;margin:22px 0 0">'+heading+'</h1></header><main style="padding:28px"><p style="color:#ded7df;line-height:1.7">'+intro+'</p>'+qrNote+'<table style="width:100%;border-collapse:collapse;margin-top:18px">'+rows+'</table><p style="color:#a99eac;font-size:12px;margin-top:28px">The Hype House · An experience worth remembering</p></main></div></body></html>';
  const text='THE HYPE HOUSE\n\n'+heading+'\n\n'+intro.replace(/<[^>]+>/g,' ')+'\n\nEvent: '+event.name+'\nDate: '+date+'\nVenue: '+event.venue;
  const mail:Mail={to:reg.email,subject:subjects[row.template],html,text};
  if(attachQr)mail.attachments=[{filename:'entry-qr.png',contentType:'image/png',content:await QRCode.toBuffer(token,{type:'png',width:360,margin:2,errorCorrectionLevel:'M'})}];
  return mail;
}
export async function processOutbox(repo:Repo,mailer:Mailer,limit=25,options:{eventTimezone?:string;ticketUrl?:string}={}):Promise<number>{
  const rows=await repo.claimOutbox(limit);let sent=0;
  for(const row of rows){
    try{
      const reg=await repo.getRegistration(row.registrationId),event=reg?getEvent(reg.eventId):null;
      if(!reg||!event)throw new Error('registration or hardcoded event config missing');
      await mailer.send({...await render(row,reg,event,options),key:row.id});
      await repo.finishOutbox(row.id,true);sent++;
    }catch(error){await repo.finishOutbox(row.id,false,error instanceof Error?error.message:String(error));}
  }
  return sent;
}