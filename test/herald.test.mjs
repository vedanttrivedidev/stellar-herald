import test from "node:test";import a from "node:assert/strict";
import{readFileSync}from"node:fs";
import{parseFeed,brief,rank,breaking,buildEdition,message,deliver,collect}from"../scripts/herald.mjs";
const cfg=JSON.parse(readFileSync(new URL("../config.json",import.meta.url)));
const now=Date.parse("2026-11-15T02:00:00Z"),ago=h=>new Date(now-h*36e5).toUTCString();
const rss=(...i)=>`<rss><channel>${i.map(([t,d,u,h])=>`<item><title><![CDATA[${t}]]></title><description><![CDATA[<p>${d}</p>]]></description><link>${u}</link><pubDate>${ago(h)}</pubDate></item>`).join("")}</channel></rss>`;
test("parses RSS and Atom",()=>{
 const r=parseFeed(rss(["A & B story","<b>Hi</b> there. More.","https://x.com/1",1]));
 a.equal(r[0].h,"A & B story");a.equal(r[0].t,"Hi there. More.");a.equal(r[0].url,"https://x.com/1");
 const at=parseFeed('<feed><entry><title>T</title><link href="https://y.org/2"/><summary>S</summary><updated>2026-11-14T20:00:00Z</updated></entry></feed>');
 a.equal(at[0].url,"https://y.org/2");a.equal(at[0].when,Date.parse("2026-11-14T20:00:00Z"))});
test("brief keeps whole sentences under 280 chars",()=>{a.equal(brief("One. "+"Two ".repeat(80)+"."),"One.");a(brief("x".repeat(500)).length<=260)});
test("story covered by two feeds outranks a lone newer one",()=>{
 const it=[{h:"Nvidia unveils new quantum chip platform",when:now-5*36e5,feed:"a"},{h:"Nvidia unveils quantum chip platform today",when:now-5*36e5,feed:"b"},{h:"Unrelated gadget review roundup",when:now-36e5,feed:"c"}];
 a.match(rank(it,now)[0].h,/Nvidia/)});
test("breaking: watched name + trigger word flagged; stale or unwatched not",()=>{
 const mk=(h,hrs,feed="a")=>({h,when:now-hrs*36e5,feed});
 const b=breaking([mk("Nvidia CEO Jensen Huang resigns",1),mk("Jensen Huang resigns from Nvidia board",2,"b"),mk("Jensen Huang resigns last year",9),mk("Local bakery owner resigns",1)],cfg,now);
 a.equal(b.length,1);a.match(b[0].h,/resigns/)});
test("edition: one story per field, stale + paywalled dropped, lead = best, IST date",()=>{
 const f=(field,h,hrs,url="https://ok.com/"+h.length,src)=>({field,h,t:"First. Second.",url,src:src||url,when:now-hrs*36e5,feed:field+h});
 const ed=buildEdition([f("Space","Moon base awards announced",2),f("Space","Old news item here",50),f("Physics","Rare decay evidence reported",3),f("Technology","Paywalled scoop story",1,"https://www.wsj.com/x")],cfg,now,[]);
 a.deepEqual(ed.stories.map(s=>s.s),["Space","Physics"]);a.equal(ed.date,"2026-11-15");a.equal(ed.stories[0].t,"First. Second.")});
test("notification: only chosen topics; breaking overrides and leads",()=>{
 const ed={date:"2026-11-15",stories:["Technology","Science","Physics","Space","Research"].map(s=>({s,h:s+" headline",t:"t",l:[["x.com","https://x.com/"+s]]}))};
 const n=message(ed,cfg,[]);a.deepEqual(n.push.split("\n").map(l=>l.split(":")[0]),["Technology","Physics","Space"]);a.equal(n.urgent,false);
 const b=message(ed,cfg,[{h:"Jensen Huang resigns",t:"t",l:[["x.com","https://x.com/b"]]}]);
 a.equal(b.push.split("\n")[0],"Breaking: Jensen Huang resigns");a(b.urgent&&b.title.startsWith("Breaking:")&&!b.push.includes("Science"))});
test("delivers push + email, skips unset channels, flags urgent, survives outage",async()=>{
 const calls=[],f=async(u,o)=>(calls.push([u,o]),{ok:true}),m={title:"T",push:"p",text:"x",html:"<p>x</p>",urgent:true};
 a.deepEqual(await deliver(m,{NTFY_TOPIC:"t1",RESEND_API_KEY:"k",EMAIL_TO:"me@x.com"},"https://site",f),{push:true,email:true});
 a.equal(JSON.parse(calls[0][1].body).priority,5);a.equal(calls[1][1].headers.Authorization,"Bearer k");a.deepEqual(JSON.parse(calls[1][1].body).to,["me@x.com"]);
 a.deepEqual(await deliver(m,{},"s",f),{});
 a.deepEqual(await deliver(m,{NTFY_TOPIC:"t1"},"s",async()=>{throw Error("down")}),{push:false})});
test("a failing feed is skipped, others kept",async()=>{
 const f=async u=>u.includes("theverge")?{ok:false,status:500}:{ok:true,text:async()=>rss(["Good story headline here","d.","https://g.com/1",1])};
 const it=await collect({feeds:{Technology:["https://www.theverge.com/rss/index.xml","https://techcrunch.com/feed/"]},watch:["Nvidia"]},f);
 a(it.some(i=>i.field==="Technology"&&i.feed.includes("techcrunch")))});
test("edition: a breaking story is not repeated as a topic story",()=>{
 const mk=(field,h,hrs)=>({field,h,t:"T.",url:"https://a.com/"+h.length,src:"https://a.com",when:now-hrs*36e5,feed:field+h});
 const br=mk("Technology","Jensen Huang resigns from Nvidia",1),ed=buildEdition([br,mk("Technology","Phone launches with big camera",2)],cfg,now,[br]);
 a.equal(ed.stories[0].h,"Phone launches with big camera");a.equal(ed.breaking[0].h,br.h)});
