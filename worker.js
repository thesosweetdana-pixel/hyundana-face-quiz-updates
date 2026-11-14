// Cloudflare Worker / Durable Object: public read-only quiz output.
// Deployment refresh: low-latency spectator polling and cached state, 2026-11-14.
// Set PUBLISH_TOKEN with: npx wrangler secret put PUBLISH_TOKEN
// Only the host browser can publish; viewers can read the current disclosed state.
const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const originAllowed=o=>o==="http://127.0.0.1:8765";
// Share public-state reads across simultaneous spectators in this Worker isolate.
let sharedState=null,sharedStateAt=0,sharedStatePending=null;
async function readSharedState(room){
 if(sharedState&&Date.now()-sharedStateAt<1200)return sharedState;
 if(sharedStatePending)return sharedStatePending;
 sharedStatePending=(async()=>{
  const r=await room.fetch("https://room/state");
  if(!r.ok)throw Error("ROOM state HTTP "+r.status);
  const data=await r.json();
  if(!data||!data.state)throw Error("ROOM returned no state");
  sharedState={state:data.state,updated:data.updated||0};
  sharedStateAt=Date.now();
  return sharedState;
 })();
 try{return await sharedStatePending}finally{sharedStatePending=null}
}
const cors=o=>({...headers,...(originAllowed(o)?{"Access-Control-Allow-Origin":o,"Vary":"Origin","Access-Control-Allow-Headers":"authorization,content-type,x-show-session,x-local-revision","Access-Control-Allow-Methods":"POST,OPTIONS"}:{})});
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,"Content-Type":"application/json;charset=utf-8",...extra}});
const empty={stage:"waiting",round:"",image:null,revealed:[],focus:null,revealStep:0,revealTotal:0};
function cleanState(raw){
 if(!raw||!["waiting","title","notice","rules","question","reveal","summary","emergency","end"].includes(raw.stage))return empty;
 const image=x=>typeof x==="string"&&/^data:image\/(png|webp);base64,/.test(x)&&x.length<12000000?x:null;
 const p=raw.stage==="reveal"&&Array.isArray(raw.revealed)?raw.revealed.slice(0,3).filter(x=>["A","B","C"].includes(x?.slot)).map(x=>({slot:x.slot,name:String(x.name||"").slice(0,90),source:String(x.source||"").slice(0,300),image:image(x.image)})):[];
 return {stage:raw.stage,round:String(raw.round||"").slice(0,80),image:["question","reveal"].includes(raw.stage)?image(raw.image):null,revealed:p,
 focus:raw.stage==="reveal"&&raw.focus?{slot:String(raw.focus.slot||""),name:String(raw.focus.name||"").slice(0,90),source:String(raw.focus.source||"").slice(0,300)}:null,revealStep:Number(raw.revealStep)||0,revealTotal:Number(raw.revealTotal)||0};
}
export class QuizRoom{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.cachedState=null;this.cachedUpdated=null;}
 async fetch(request){
  const u=new URL(request.url);
  if(request.method==="GET"&&u.pathname==="/preflight"){
   const names=["standby.webp","intro.webp","notice.png","rules.png","question.webp","answer.webp","next.mp4","end.webp"];
   const assetMetas=await Promise.all(names.map(n=>this.ctx.storage.get("asset:"+n+":meta")));
   return json({online:this.ctx.getWebSockets().length,transport:"websocket",
     assets:names.map((name,i)=>({name,installed:!!assetMetas[i],size:assetMetas[i]?.size||0})),
     release:"1.8.10"});
  }
  if(request.method==="GET"&&u.pathname==="/viewers"){
   return json({online:this.ctx.getWebSockets().length,transport:"websocket",release:"1.8.10"});
  }
  if(request.method==="GET"&&u.pathname==="/socket"&&request.headers.get("Upgrade")?.toLowerCase()==="websocket"){
   const pair=new WebSocketPair();
   const [client,server]=Object.values(pair);
   this.ctx.acceptWebSocket(server);
   // Newly connected viewers receive the latest public scene exactly once.
   try{
    if(this.cachedState===null){
     const count=await this.ctx.storage.get("count")||0;let value=empty;
     if(count){
      const parts=await Promise.all(Array.from({length:count},(_,i)=>this.ctx.storage.get("part:"+i)));
      try{value=JSON.parse(parts.join(""))}catch(_){value=empty}
     }
     this.cachedState=value;
    }
    if(this.cachedUpdated===null)this.cachedUpdated=await this.ctx.storage.get("updated")||0;
    server.send(JSON.stringify({revision:String(this.cachedUpdated),state:this.cachedState,connected:true}));
   }catch(e){try{server.send(JSON.stringify({error:"Initial state temporarily unavailable"}))}catch(_){}}
   return new Response(null,{status:101,webSocket:client});
  }
  if(request.method==="POST"&&u.pathname==="/publish"){
   const presenter=request.headers.get("X-Show-Session")||"";
   const revision=Number(request.headers.get("X-Local-Revision"));
   if(!/^studio-[a-zA-Z0-9.-]{12,110}$/.test(presenter)||!Number.isSafeInteger(revision)||revision<0)return json({error:"invalid presenter revision"},409);
   // Dedupe repeated acknowledgements and never rewind the same controller.
   if(this.lastPresenter===presenter&&this.lastLocalRevision!==undefined&&revision<=this.lastLocalRevision)return json({ok:true,unchanged:true});
   let raw;try{raw=await request.json();}catch{return json({error:"invalid json"},400);}
   if(JSON.stringify(raw).length>14000000)return json({error:"state too large"},413);
   const state=cleanState(raw);
   const packed=JSON.stringify(state);const parts=packed.match(/[\s\S]{1,800000}/g)||[];
   await Promise.all(parts.map((part,i)=>this.ctx.storage.put("part:"+i,part)));
   await this.ctx.storage.put("count",parts.length);
   const updated=Date.now();await this.ctx.storage.put("updated",updated);
   this.cachedState=state;this.cachedUpdated=updated;
   this.lastPresenter=presenter;this.lastLocalRevision=revision;
   const update=JSON.stringify({revision:String(updated),state,connected:true});
   for(const socket of this.ctx.getWebSockets()){
    try{socket.send(update)}catch(e){try{socket.close(1011,"Delivery interrupted")}catch(_){}}
   }
   return json({ok:true});
  }
  if(request.method==="POST"&&u.pathname==="/asset"){
   const name=u.searchParams.get("name")||"";
   if(!["question.webp","answer.webp","next.mp4","standby.webp","intro.webp","end.webp","notice.png","rules.png"].includes(name))return json({error:"unsupported asset"},400);
   const bytes=new Uint8Array(await request.arrayBuffer());
   if(bytes.length<8||bytes.length>20000000)return json({error:"asset size limit"},413);
   const parts=Math.ceil(bytes.length/700000);
   for(let i=0;i<parts;i++)await this.ctx.storage.put("asset:"+name+":"+i,bytes.slice(i*700000,(i+1)*700000));
   await this.ctx.storage.put("asset:"+name+":meta",{size:bytes.length,count:parts});
   return json({ok:true,name,size:bytes.length});
  }
  if(request.method==="GET"&&u.pathname.startsWith("/asset/")){
   const name=u.pathname.split("/").pop(),meta=await this.ctx.storage.get("asset:"+name+":meta");
   if(!meta)return new Response("missing asset",{status:404});
   const bytes=new Uint8Array(meta.size);
   for(let i=0;i<meta.count;i++){const part=await this.ctx.storage.get("asset:"+name+":"+i);if(!part)return new Response("asset unavailable",{status:503});bytes.set(part,i*700000);}
   const match=(request.headers.get("Range")||"").match(/^bytes=(\d+)-(\d*)$/);
   const start=match?Number(match[1]):0,end=match?(match[2]?Math.min(bytes.length-1,Number(match[2])):bytes.length-1):bytes.length-1;
   if(start>=bytes.length||end<start)return new Response(null,{status:416,headers:{"Content-Range":"bytes */"+bytes.length}});
   const type=name.endsWith(".mp4")?"video/mp4":name.endsWith(".png")?"image/png":"image/webp";
   const head={"Content-Type":type,"Accept-Ranges":"bytes","Content-Length":String(end-start+1),"Cache-Control":"public, max-age=3600"};if(match)head["Content-Range"]="bytes "+start+"-"+end+"/"+bytes.length;
   return new Response(bytes.slice(start,end+1),{status:match?206:200,headers:head});
  }
  if(this.cachedUpdated===null)this.cachedUpdated=await this.ctx.storage.get("updated")||0;
  const updated=this.cachedUpdated;
  if(u.searchParams.has("rev")&&u.searchParams.get("rev")===String(updated))return json({updated,unchanged:true});
  if(this.cachedState===null){
   const count=await this.ctx.storage.get("count")||0;let state=empty;
   if(count){
    const parts=await Promise.all(Array.from({length:count},(_,i)=>this.ctx.storage.get("part:"+i)));
    try{state=JSON.parse(parts.join(""))}catch{state=empty}
   }
   this.cachedState=state;
  }
  return json({state:this.cachedState,updated});
 }
}
const VIEWER=String.raw`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>현단아의 뉴뀨? 참가자 화면</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#1e102e;font-family:system-ui,'Malgun Gothic',sans-serif;color:#fff}#shell{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5vw}.stage{width:min(100%,1672px);aspect-ratio:1672/941;position:relative;border-radius:2vw;overflow:hidden;background:radial-gradient(ellipse at 50% 30%,#64349b,#220b3b 70%);border:4px solid #d87bfc;box-shadow:0 0 45px #b95dff88,inset 0 0 30px #ff91e6}.stars{position:absolute;inset:0;opacity:.38;background-image:radial-gradient(circle at 12% 16%,#fff 1px,transparent 3px),radial-gradient(circle at 72% 23%,#fff 1px,transparent 3px),radial-gradient(circle at 42% 73%,#fff 2px,transparent 4px);background-size:240px 180px}.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:2vw}.major{font-weight:1000;font-size:clamp(32px,7vw,116px);color:#fff1fa;text-shadow:0 4px #dc64b6,0 7px #7424a4,0 0 24px #f091e7}.sub{font-size:clamp(14px,2vw,34px);color:#f6cafa}.photo{display:none;position:absolute;object-fit:contain;border:3px solid #f5a5fb;border-radius:1.3vw;box-shadow:0 0 22px #f291f7;background:#13091b}.stage[data-stage=question] .photo{display:block;inset:19% 17% 8%;width:66%;height:73%}.stage[data-stage=reveal] .photo{display:block;left:5%;top:23%;width:34%;height:65%;object-fit:cover}.top{position:absolute;top:4%;left:6%;right:6%;display:flex;justify-content:space-between;align-items:center;color:#fce2ff;font-weight:1000;font-size:clamp(13px,3vw,45px)}.answers{position:absolute;left:43%;right:3%;top:23%;height:67%;display:none;grid-template-columns:repeat(3,1fr);gap:1.5%}.stage[data-stage=reveal] .answers{display:grid}.card{min-width:0;display:flex;flex-direction:column;align-items:center;gap:1%;}.card img{height:75%;width:100%;object-fit:cover;background:#4b2a67;border:2px solid #eaa0ef;border-radius:1vw}.card .name,.card .source{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:clamp(10px,1.55vw,25px);font-weight:850}.card .source{font-size:clamp(8px,1vw,18px)}.waiting{display:none}.stage[data-stage=waiting] .waiting,.stage[data-stage=summary] .waiting,.stage[data-stage=title] .waiting,.stage[data-stage=end] .waiting,.stage[data-stage=emergency] .waiting{display:flex}.status{position:fixed;bottom:8px;right:12px;font-size:11px;color:#ceb6dc}video{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none}.stage[data-stage=summary] video{display:block}
</style></head><body><div id="shell"><div id="stage" class="stage" data-stage="waiting"><div class="stars"></div><div class="top" id="top" hidden><span id="round">ROUND 01</span><span>현단아의 뉴뀨? ♡</span></div><div class="center waiting"><div class="major" id="message">준비중...♡</div><div class="sub" id="subtitle">진행자의 화면을 기다리고 있어요</div></div><img id="photo" class="photo" alt="공개된 퀴즈 사진"><div class="answers" id="answers"></div><video id="nextVideo" muted autoplay playsinline preload="auto"></video></div></div><div class="status" id="status">연결 중…</div><script>
(()=>{'use strict';const stage=document.getElementById('stage'),photo=document.getElementById('photo'),top=document.getElementById('top'),answers=document.getElementById('answers'),msg=document.getElementById('message'),sub=document.getElementById('subtitle'),status=document.getElementById('status'),vid=document.getElementById('nextVideo');let prev='',last=0,mediaReady=false;
const scenes={waiting:['준비중...♡','잠시 후 시작합니다'],title:['현단아의 뉴뀨?','연예인 얼굴 합성 퀴즈'],summary:['다음 문제 준비중...♡','잠시 후 다음 문제가 공개됩니다'],end:['감사합니다 ♡','함께해 주셔서 감사해요'],emergency:['화면 준비 중','진행자의 연결을 기다립니다']};
function render(s){const stageName=s.stage||'waiting',change=prev!==stageName;prev=stageName;stage.dataset.stage=stageName;top.hidden=!['question','reveal'].includes(stageName);document.getElementById('round').textContent=(s.round||'ROUND 01').replace('라운드','ROUND');
if(scenes[stageName]){msg.textContent=scenes[stageName][0];sub.textContent=scenes[stageName][1]}else{msg.textContent='';sub.textContent=''}
if(['question','reveal'].includes(stageName)&&s.image){if(photo.src!==s.image)photo.src=s.image;photo.style.display='block'}else{photo.removeAttribute('src');photo.style.display='none'}
answers.replaceChildren();if(stageName==='reveal'){for(const letter of ['A','B','C']){const p=(s.revealed||[]).find(x=>x.slot===letter);const card=document.createElement('div');card.className='card';const img=document.createElement('img');if(p?.image)img.src=p.image;const name=document.createElement('div');name.className='name';name.textContent=p?.name||'';const source=document.createElement('div');source.className='source';source.textContent=p?.source||'';card.append(img,name,source);answers.append(card)}}
if(stageName==='summary'&&change&&mediaReady){vid.currentTime=0;vid.play().catch(()=>{});}else if(stageName!=='summary')vid.pause();
}
// Public viewers use WebSocket only. Legacy HTTP polling intentionally removed.
fetch('/assets/next.mp4',{method:'HEAD'}).then(r=>{if(r.ok){vid.src='/assets/next.mp4';mediaReady=true}}).catch(()=>{});
(function connect(){
 const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/stream');
 ws.onmessage=e=>{try{const d=JSON.parse(e.data);if(d?.state){render(d.state);status.textContent='실시간 연결됨';}}catch(_){}};
 ws.onclose=()=>{status.textContent='재연결 중…';setTimeout(connect,5000)};
 ws.onerror=()=>{try{ws.close()}catch(_){}};
})();
})();</script></body></html>`;
export default {
 async fetch(request,env){
  const u=new URL(request.url),origin=request.headers.get("Origin")||"";
  if(request.method==="OPTIONS"&&(u.pathname==="/publish"||u.pathname==="/upload"))return new Response(null,{status:204,headers:cors(origin)});
  if(u.pathname==="/health")return json({ok:true,release:"1.8.10-ws",requiresLocalAck:true,transport:"websocket"});
  if(u.pathname==="/diagnostics"){
   try{
    if(!env.ROOM)return json({ok:false,release:"1.8.8-diagnostics",component:"ROOM",issue:"binding-missing"},503);
    const room=env.ROOM.get(env.ROOM.idFromName("live"));
    const r=await room.fetch("https://room/state");
    return json({ok:r.ok,release:"1.8.8-diagnostics",component:"ROOM",status:r.status},r.ok?200:503);
   }catch(err){
    const detail=String(err?.message||err).slice(0,220);
    return json({ok:false,release:"1.8.8-diagnostics",component:"ROOM",error:detail},503);
   }
  }
  const room=env.ROOM.get(env.ROOM.idFromName("live"));
  if(u.pathname==="/publish"){
   if(request.method!=="POST")return json({error:"not allowed"},405);
   if(!originAllowed(origin))return json({error:"invalid origin"},403);
   if(!env.PUBLISH_TOKEN||request.headers.get("Authorization")!=="Bearer "+env.PUBLISH_TOKEN)return json({error:"unauthorized"},401, cors(origin));
   // Reject legacy studio tabs which publish on independent timers without OBS ownership.
   const presenter=request.headers.get("X-Show-Session")||"";
   const localRevision=Number(request.headers.get("X-Local-Revision"));
   if(!/^studio-[a-zA-Z0-9.-]{12,110}$/.test(presenter)||!Number.isSafeInteger(localRevision)||localRevision<0)
     return json({error:"update studio to v1.8.6: local OBS acknowledgement required"},409,cors(origin));
   let response;try{response=await room.fetch(new Request("https://room/publish",{method:"POST",body:request.body,headers:{"Content-Type":"application/json","X-Show-Session":presenter,"X-Local-Revision":String(localRevision)}}));}catch(e){return json({error:"Cloudflare ROOM unavailable; inspect Durable Object logs and quotas"},503,cors(origin));}
   if(response.ok){sharedState=null;sharedStateAt=0;}
   return new Response(response.body,{status:response.status,headers:{...cors(origin),"Content-Type":"application/json"}});
  }
  if(u.pathname==="/upload"){
   if(request.method!=="POST"||!originAllowed(origin)||!env.PUBLISH_TOKEN||request.headers.get("Authorization")!=="Bearer "+env.PUBLISH_TOKEN)return json({error:"unauthorized"},401,cors(origin));
   const name=u.searchParams.get("name")||"";
   let response;try{response=await room.fetch(new Request("https://room/asset?name="+encodeURIComponent(name),{method:"POST",body:request.body}));}catch(e){return json({error:"Cloudflare ROOM unavailable; poster upload blocked"},503,cors(origin));}
   return new Response(response.body,{status:response.status,headers:{...cors(origin),"Content-Type":"application/json"}});
  }
  if(u.pathname==="/stream"){
   if(request.headers.get("Upgrade")?.toLowerCase()!=="websocket")return json({error:"WebSocket upgrade required"},426);
   try{return await room.fetch(new Request("https://room/socket",{headers:{"Upgrade":"websocket"}}))}
   catch(e){return json({error:"WebSocket room unavailable"},503)}
  }
  if(u.pathname==="/preflight"){
   try{
    const result=await room.fetch("https://room/preflight");
    return new Response(result.body,{status:result.status,headers:{...cors(origin),"Content-Type":"application/json;charset=utf-8"}});
   }catch(e){return json({error:"Durable Object connection or free daily limit",ok:false},503,cors(origin))}
  }
  if(u.pathname==="/viewers"){
   try{
    const result=await room.fetch("https://room/viewers");
    return new Response(result.body,{status:result.status,headers:{...cors(origin),"Content-Type":"application/json;charset=utf-8"}});
   }catch(e){return json({online:null,error:"중계 서버 용량 또는 일일 한도를 확인하세요"},503,cors(origin))}
  }
  // Disable deprecated unbounded public polling. Prevent cached older viewer pages
  // from burning the entire free Durable Object daily request allowance.
  if(u.pathname==="/state"||u.pathname==="/api/public")
    return json({error:"legacy HTTP polling disabled; reload /obs for WebSocket"},410);
  if(u.pathname==="/obs"){
   try{
    const upstream=await fetch("https://raw.githubusercontent.com/thesosweetdana-pixel/hyundana-face-quiz-updates/main/obs.html",{cf:{cacheTtl:0,cacheEverything:true}});
    if(upstream.ok){
     // Remote spectators must never be switched to the emergency/standby scene
     // merely because a single poll timed out. Keep the last valid stage.
     let html=await upstream.text();
     html=html.replace("const timer=setTimeout(()=>controller.abort(),2700)", "const timer=setTimeout(()=>controller.abort(),9000)")
      .replace("}catch(e){revision=null;render(null,false)}setTimeout(poll,350)",
       "}catch(e){/* preserve last successfully received public stage on network failure */}setTimeout(poll,300)");
     if(u.searchParams.has("debug")){
       html=html.replace("if(!d.unchanged)render(d.state,d.connected);",
        "if(!d.unchanged)render(d.state,d.connected);document.title='참가자 진단 · '+sceneStage+' · rev '+revision;");
     }
     return new Response(html,{headers:{...headers,"Content-Type":"text/html;charset=utf-8"}});
    }
   }catch(_){}
   return new Response(VIEWER,{headers:{...headers,"Content-Type":"text/html;charset=utf-8"}});
  }
  if(u.pathname==="/"||u.pathname==="/watch")return Response.redirect(new URL("/obs",u.origin).toString(),302);
  if(u.pathname.startsWith("/assets/")){
   let remote;try{remote=await room.fetch(new Request("https://room/asset/"+u.pathname.split("/").pop(),{headers:{"Range":request.headers.get("Range")||""}}));}catch(e){return new Response("Cloudflare room temporarily unavailable",{status:503,headers});}
   if(remote.status!==404)return remote;
   return env.ASSETS?env.ASSETS.fetch(request):new Response("asset not installed",{status:404});
  }
  return new Response("Not found",{status:404});
 }
};
