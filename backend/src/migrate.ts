import { readdirSync,readFileSync } from 'node:fs';
const {default:pg}=await import('pg');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL_DIRECT??process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='disable'?false:{rejectUnauthorized:false}});
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const directory=new URL('../db/',import.meta.url);
for(const file of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort()){
  if((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).rowCount)continue;
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query(readFileSync(new URL(file,directory),'utf8'));await client.query('INSERT INTO schema_migrations (name) VALUES ($1)',[file]);await client.query('COMMIT');console.log('applied',file);}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
await pool.end();