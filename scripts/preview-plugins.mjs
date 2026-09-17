#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
if (!process.argv.includes("--no-build")) {
	const build = spawnSync(process.execPath, ["scripts/build-plugins.mjs"], { cwd: root, stdio: "inherit" });
	if (build.status) process.exit(build.status ?? 1);
}

const plugins = readdirSync(join(root, "plugins"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(root, "plugins", entry.name, "client", "entry.mjs")))
	.map((entry) => entry.name)
	.sort();

const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plugin preview</title><style>
:root{font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:#172b4d;background:#f7f8fa}*{box-sizing:border-box}body{margin:0}.shell{display:grid;grid-template-columns:300px 1fr;min-height:100vh}.controls{padding:18px;border-right:1px solid #dfe1e6;background:white}.controls h1{margin:0 0 16px;font-size:18px}.controls label{display:grid;gap:5px;margin:12px 0;font-weight:650}.controls select,.controls textarea,.controls button{width:100%;padding:9px;border:1px solid #b7bec8;border-radius:7px;font:inherit}.controls textarea{min-height:240px;font:12px/1.4 ui-monospace,monospace}.controls button{margin-top:8px;background:#0c66e4;color:white;border:0;font-weight:700;cursor:pointer}.stage{padding:28px;overflow:auto}.surface{min-height:calc(100vh - 56px);padding:20px;border:1px solid #dfe1e6;border-radius:12px;background:white}.log{margin-top:16px;padding:10px;max-height:160px;overflow:auto;border-radius:7px;background:#091e42;color:#dfe1e6;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap}@media(max-width:800px){.shell{grid-template-columns:1fr}.controls{border-right:0;border-bottom:1px solid #dfe1e6}.stage{padding:12px}}
</style></head><body><main class="shell"><aside class="controls"><h1>Plugin preview</h1>
<label>Plugin<select id="plugin"></select></label><label>Surface<select id="surface"><option value="dashboard">Dashboard/tab</option><option value="settings">Settings page</option></select></label>
<label>Fixture state<textarea id="fixture"></textarea></label><button id="push">Push fixture</button><pre class="log" id="log"></pre></aside>
<section class="stage"><div id="surface-wrap"><div class="surface" id="mount"></div></div></section></main>
<script type="module">
const plugins=${JSON.stringify(plugins)};
const pluginSelect=document.querySelector('#plugin'), surfaceSelect=document.querySelector('#surface'), fixture=document.querySelector('#fixture'), mount=document.querySelector('#mount'), wrap=document.querySelector('#surface-wrap'), log=document.querySelector('#log');
for(const id of plugins) pluginSelect.append(Object.assign(document.createElement('option'),{value:id,textContent:id}));
const listeners=new Set(); let cleanup;
const write=(value)=>{log.textContent+=JSON.stringify(value,null,2)+'\n';log.scrollTop=log.scrollHeight};
window.__piWebUiHost={version:11,models:{list:()=>[{id:'openai/gpt-5-mini',provider:'openai',name:'GPT-5 mini'},{id:'anthropic/claude-sonnet',provider:'anthropic',name:'Claude Sonnet'}]},startChat:(options)=>(write({startChat:options}),true),openSession:async(options)=>(write({openSession:options}),{ok:true,sessionId:'preview'}),setView:(view)=>write({setView:view}),compose:(options)=>(write({compose:options}),true)};
const jiraFixture={kind:'state',state:{configured:true,config:{siteUrl:'https://example.atlassian.net',email:'agent@example.com',boardId:'42',readyJql:'statusCategory = "To Do"'},workspaceCwd:'/workspace/selected-project',activeSprint:{id:7,name:'Sprint 24',state:'active'},folders:['apps/web','packages/api','tests'],tickets:[{key:'WEB-142',summary:'Improve account recovery flow',description:'',status:'In Progress',assignee:'Alex Morgan',labels:[]},{key:'WEB-158',summary:'Add audit events for permission changes',description:'',status:'To Do',assignee:null,labels:['security']},{key:'WEB-161',summary:'Document the deployment rollback path',description:'',status:'Ready',assignee:'Sam Lee',labels:['dogits-dans-le-nez']}],reviewing:{'WEB-158':Date.now()},reviews:{'WEB-161':{ready:true,difficulty:'easy',confidence:'high',rationale:'Acceptance criteria are concrete.',missingInfo:[],implementationPlan:['Update the runbook.'],draftComment:'Ready to implement.',confidenceSuggestions:[]}},notice:'Preview fixture'}};
function pushFixture(){try{const payload=JSON.parse(fixture.value);for(const listener of listeners)listener(payload)}catch(error){write({error:String(error)})}}
async function load(){cleanup?.();listeners.clear();mount.replaceChildren();log.textContent='';wrap.className=surfaceSelect.value==='settings'?'plugin-page':'';const id=pluginSelect.value;fixture.value=JSON.stringify(id==='jira-review'?jiraFixture:{kind:'state',state:{}},null,2);try{const mod=await import('/plugins/'+encodeURIComponent(id)+'/client/entry.mjs?t='+Date.now());const entry=mod.default??mod;cleanup=entry.mount?.(mount,{pluginId:id,send:(payload)=>write({send:payload}),onData:(listener)=>(listeners.add(listener),()=>listeners.delete(listener))});pushFixture()}catch(error){write({error:error?.stack||String(error)})}}
pluginSelect.addEventListener('change',load);surfaceSelect.addEventListener('change',load);document.querySelector('#push').addEventListener('click',pushFixture);load();
</script></body></html>`;

const mime = {
	".html": "text/html; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};
const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
	if (url.pathname === "/") {
		response.writeHead(200, { "Content-Type": mime[".html"] });
		response.end(html);
		return;
	}
	const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
	const path = join(root, relative);
	if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
		response.writeHead(404).end("Not found");
		return;
	}
	response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" });
	createReadStream(path).pipe(response);
});
server.listen(port, "127.0.0.1", () => console.log(`Plugin preview: http://127.0.0.1:${port}`));
