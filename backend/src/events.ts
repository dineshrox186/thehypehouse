import type { EventRow } from './types.ts';

// This file is the sole source of event information. There are no event CRUD endpoints or events table.
// Update this catalogue in code when Hype House announces dates, venue, capacity and registration windows.
export const EVENTS: EventRow[] = [
  { id:'pool-party', name:'The Hype House Pool Party', description:'Event details are coming soon.', startsAt:null, venue:'Coming soon', address:'', mapUrl:'', capacity:0, coverImage:'/thehypehouse-pool-poster-2160p.jpg', published:true, registrationEnabled:false, regOpensAt:null, regClosesAt:null, terms:'Registration details will be announced soon.', fields:[] }
];
export function getEvent(id:string):EventRow|null { return EVENTS.find(event=>event.id===id) ?? null; }
