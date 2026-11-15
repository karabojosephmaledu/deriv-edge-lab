const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('account release preserves original execution/frontend engine and frozen research',()=>{
 for(const file of ['backend/lib/deriv_demo.py','backend/routers/deriv.py','frontend/public/app.js','frontend/public/research.js'])assert.equal(read(file),execFileSync('git',['show','fae1746:'+file],{cwd:root,encoding:'utf8'}));
 assert.equal(read('tests/fixtures/legacy-dashboard.html'),execFileSync('git',['show','fae1746:frontend/index.html'],{cwd:root,encoding:'utf8'}));
});
test('production entry has only account display and Matches research, with no order controls or virtual wallet',()=>{
 const html=read('frontend/index.html'),app=read('frontend/public/account.js');
 assert.match(html,/<script src="\/account.js" defer>/);assert.doesNotMatch(html,/<script src="\/(app|research).js"/);
 assert.doesNotMatch(html,/id="(?:virtual-wallet|wallet-start|wallet-current|execution-mode|lab-card|start-btn)"|data-product=|value="(?:differs|accu|mult|touch|notouch)"/);
 assert.doesNotMatch(app,/\/demo\/|contract_update|DIGITDIFF|MULTUP|MULTDOWN|ONETOUCH|NOTOUCH/);
 assert.match(app,/c\.id==="matches"/);assert.match(html,/Real accounts are view-only/);
});
test('account UI reuses original OAuth PKCE and original notification sound generators',()=>{
 const before=read('frontend/public/app.js'),after=read('frontend/public/account.js');
 for(const [start,end]of [['async function startOAuth()','async function demoApi('],['let audioCtx =','function renderSoundToggle('],['function makeSocket(','/* --------------------------- public market']]){
   const piece=before.slice(before.indexOf(start),before.indexOf(end)).trim();assert.ok(after.includes(piece),'Component changed: '+start);
 }
 assert.match(after,/const redirectUri = \(\) => location.origin \+ "\/api\/deriv\/callback"/);
});
