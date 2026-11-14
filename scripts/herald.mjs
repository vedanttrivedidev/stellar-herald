import{readFileSync,writeFileSync,mkdirSync,existsSync}from"node:fs";
import{pathToFileURL}from"node:url";
const H=36e5;
const strip=s=>(s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&#8217;|&rsquo;/g,"’").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();
const tag=(x,t)=>{const m=x.match(new RegExp("<"+t+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+t+">","i"));return m?strip(m[1]):""};
export const parseFeed=xml=>[...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map(m=>{const x=m[0],url=(x.match(/<link[^>]*?href="([^"]+)"/i)||[])[1]||tag(x,"link");return{h:tag(x,"title"),t:tag(x,"description")||tag(x,"summary")||tag(x,"content"),url,src:(x.match(/<source[^>]*?url="([^"]+)"/i)||[])[1]||url,when:Date.parse(tag(x,"pubDate")||tag(x,"published")||tag(x,"updated"))||0}}).filter(i=>i.h&&/^https?:\/\//.test(i.url));
export const brief=t=>{let o="";for(const s of t.match(/[^.!?]+[.!?]+(?:\s|$)/g)||[]){if((o+s).length>280)break;o+=s}return(o||t.slice(0,260)).trim()};
const W=s=>new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g)||[]);
export const similar=(a,b)=>{const B=W(b);return[...W(a)].filter(w=>B.has(w)).length>=3};
// score = freshness (max 24) + 6 per other feed covering the same story
export const rank=(items,now)=>items.map(i=>({...i,score:Math.max(0,24-(now-i.when)/H)+6*new Set(items.filter(o=>o.feed!==i.feed&&similar(o.h,i.h)).map(o=>o.feed)).size})).sort((a,b)=>b.score-a.score);
// breaking = fresh (<6h) + trigger word + (watched name OR reported by 2+ feeds)
export const breaking=(items,cfg,now)=>{const re=new RegExp("\\b("+cfg.breakingWords+")\\b","i"),out=[];for(const i of items){if(now-i.when>6*H||!re.test(i.h))continue;const watched=cfg.watch.some(w=>i.h.toLowerCase().includes(w.toLowerCase()));if((watched||items.some(o=>o.feed!==i.feed&&similar(o.h,i.h)))&&!out.some(o=>similar(o.h,i.h)))out.push(i)}return out};
const host=u=>{try{return new URL(u).hostname.replace(/^www\./,"")}catch{return u}};
const links=(i,all)=>[...new Map([i,...all.filter(o=>o.feed!==i.feed&&similar(o.h,i.h))].map(o=>[o.url,[host(o.src),o.url]])).values()].slice(0,3);
export function buildEdition(items,cfg,now,br=[]){
 const ok=items.filter(i=>!(cfg.paywalled&&new RegExp(cfg.paywalled,"i").test(i.src))),fresh=ok.filter(i=>now-i.when<cfg.maxAgeHours*H&&!br.some(b=>similar(b.h,i.h)));
 const stories=Object.keys(cfg.feeds).flatMap(f=>rank(fresh.filter(i=>i.field===f),now).slice(0,cfg.perField||1).map(i=>({score:i.score,s:f,h:i.h,t:brief(i.t),l:links(i,fresh)}))).sort((a,b)=>b.score-a.score).map(({score,...x})=>x);
 return{date:new Intl.DateTimeFormat("en-CA",{timeZone:cfg.tz}).format(now),notify:cfg.notifyTopics,breaking:br.map(i=>({h:i.h,t:brief(i.t),l:links(i,ok)})),stories}}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// chosen topics only; breaking news always included, first
export function message(ed,cfg,br){
 const all=[...br.map(b=>({k:"Breaking",...b})),...ed.stories.filter(s=>cfg.notifyTopics.includes(s.s)).map(s=>({k:s.s,...s}))];
 return{urgent:br.length>0,title:br.length?"Breaking: "+br[0].h:"Stellar Herald, "+ed.date,push:all.map(x=>x.k+": "+x.h).join("\n"),
  text:all.map(x=>x.k+": "+x.h+"\n"+x.t+"\n"+x.l.map(l=>l[1]).join("\n")).join("\n\n"),
  html:all.map(x=>`<h3>${esc(x.k)}: ${esc(x.h)}</h3><p>${esc(x.t)}</p><p>${x.l.map(l=>`<a href="${esc(l[1])}">${esc(l[0])}</a>`).join(" | ")}</p>`).join("")}}
export const deliver=async(m,env,site,f=fetch)=>{const jobs=[];
 if(env.NTFY_TOPIC)jobs.push(["push",f("https://ntfy.sh",{method:"POST",body:JSON.stringify({topic:env.NTFY_TOPIC,title:m.title,message:m.push,click:site,priority:m.urgent?5:3,tags:[m.urgent?"rotating_light":"newspaper"]})})]);
 if(env.RESEND_API_KEY&&env.EMAIL_TO)jobs.push(["email",f("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:"Stellar Herald <onboarding@resend.dev>",to:[env.EMAIL_TO],subject:m.title,html:m.html,text:m.text})})]);
 return Object.fromEntries(await Promise.all(jobs.map(async([k,p])=>[k,await p.then(r=>r.ok,()=>false)])))};
export const collect=async(cfg,f=fetch)=>(await Promise.all([...Object.entries(cfg.feeds).flatMap(([field,us])=>us.map(u=>[field,u])),["Breaking","https://news.google.com/rss/search?q="+encodeURIComponent(cfg.watch.map(w=>`"${w}"`).join(" OR ")+" when:1d")]].map(async([field,u])=>{try{const r=await f(u,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(r.status);return parseFeed(await r.text()).map(i=>({...i,field,feed:u}))}catch(e){console.error("feed failed:",u,e.message);return[]}}))).flat();
async function main(){
 const mode=process.argv[2]||"morning",cfg=JSON.parse(readFileSync("config.json","utf8")),now=Date.now();
 const items=await collect(cfg),seen=existsSync("docs/seen.json")?JSON.parse(readFileSync("docs/seen.json","utf8")):[];
 const br=breaking(items,cfg,now),fresh=br.filter(i=>!seen.includes(i.url)),ed=buildEdition(items,cfg,now,br);
 mkdirSync("docs/archive",{recursive:true});
 if(ed.stories.length&&(mode==="morning"||fresh.length)){writeFileSync("docs/edition.json",JSON.stringify(ed,null,1));if(mode==="morning")writeFileSync(`docs/archive/${ed.date}.json`,JSON.stringify(ed))}
 const sendBr=mode==="morning"?ed.breaking:ed.breaking.filter((_,k)=>fresh.includes(br[k]));
 const m=message(mode==="morning"?ed:{...ed,stories:[]},cfg,sendBr);
 if(m.push)console.log("delivered",await deliver(m,process.env,cfg.site));else console.log("nothing to send");
 writeFileSync("docs/seen.json",JSON.stringify([...seen,...fresh.map(i=>i.url)].slice(-200)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
