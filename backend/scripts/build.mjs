// Strip TypeScript with Node's built-in stripper and rewrite local .ts imports.
import { stripTypeScriptTypes } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
let count = 0;
for (const file of readdirSync('src').filter(name => name.endsWith('.ts'))) {
  const js = stripTypeScriptTypes(readFileSync('src/' + file, 'utf8'), { mode: 'strip' })
    .replace(/(from\s+|import\()\s*(['"])(\.\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
  writeFileSync('dist/' + file.replace(/\.ts$/, '.js'), js);
  count++;
}
console.log('Built ' + count + ' Hype House backend modules.');