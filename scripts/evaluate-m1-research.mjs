// Offline replay of the frozen protocol. This script has no network/order API.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evaluate} from '../research/m1/engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const protocol=JSON.parse(fs.readFileSync(path.join(root,'research/m1/protocol.json')));
const directory=path.resolve(process.argv[2]||path.join(root,'research/m1/data'));
const markets={},provenance=[];
for(const symbol of protocol.markets){
 const bytes=fs.readFileSync(path.join(directory,symbol+'.json.gz')),m=JSON.parse(zlib.gunzipSync(bytes));
 if(m.symbol!==symbol)throw Error('Snapshot symbol mismatch');
 for(const [name,hash]of Object.entries(m.frozen_sha256))if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')!==hash)throw Error('Frozen implementation changed after capture: '+name);
 markets[symbol]=m;provenance.push({symbol,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bars:m.bars.length,captured_at:m.captured_at,frozen_commit:m.frozen_commit});
}
const report={...evaluate(markets,protocol),provenance,limitations:protocol.limitations};
const full=path.join(directory,'results-full.json');fs.writeFileSync(full,JSON.stringify(report)+'\n');
const compact=structuredClone(report);
for(const row of compact.rows)for(const part of ['training','validation','stress','test','testStress'])delete row[part].history;
fs.writeFileSync(path.join(root,'research/m1/results.json'),JSON.stringify(compact,null,2)+'\n');
console.log(JSON.stringify(compact,null,2));
