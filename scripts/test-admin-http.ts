import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { seedDemoCatalog,demoId } from "../prisma/seed";
import { getSalon } from "../src/lib/salon";
import { provisionFirstAdmin } from "../src/lib/admin-auth";
import { salonDateString,addCalendarDays } from "../src/lib/salon-time";

// Publicly known credentials exist only in a disposable QA schema on loopback.
const credentials={email:"qa-browser@example.invalid",password:"QA-browser-only-October-2026!"};
const schema="qa_romeo_admin_http_"+randomUUID().replaceAll("-","");
const origin="http://127.0.0.1:3001";
const production=process.argv.includes("--production");
const payments=process.argv.includes("--test-payments");
const browserOrigin=production?"https://qa-salon.example":origin;
const proxyHeaders:Record<string,string>=production?{host:"qa-salon.example","x-forwarded-proto":"https"}:{};
// Node 24 fetch rewrites Host. Raw HTTP preserves the reverse proxy's actual
// authority, so the HTTPS regression exercises the server, not a mocked Request.
async function fetch(url:string,options:RequestInit={}):Promise<Response>{
  if(!production)return globalThis.fetch(url,options);
  return new Promise((resolve,reject)=>{
    const request=httpRequest(url,{method:options.method??"GET",headers:Object.fromEntries(new Headers(options.headers))},response=>{
      const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(Buffer.from(chunk)));response.on("error",reject);
      response.on("end",()=>{const headers=new Headers();for(const [name,value] of Object.entries(response.headers))if(value!==undefined)for(const item of Array.isArray(value)?value:[value])headers.append(name,item);resolve(new Response(Buffer.concat(chunks),{status:response.statusCode!,headers}));});
    });
    request.setTimeout(15000,()=>request.destroy(new Error("QA timeout")));request.on("error",reject);
    request.end(typeof options.body==="string"?options.body:undefined);
  });
}
let current="Подготовка QA";
async function main(){
  if(process.env.NODE_ENV==="production"||!process.env.DATABASE_URL||!/^qa_romeo_admin_http_[a-f0-9]{32}$/.test(schema)||production&&payments)throw Error("QA configuration");
  const connectionString=process.env.DATABASE_URL;
  const options="-c timezone=UTC -c search_path="+schema+",public";
  const sql=new Client({connectionString,options});
  const database=new PrismaClient({adapter:new PrismaPg({connectionString,options},{schema})});
  let server:ReturnType<typeof spawn>|undefined;let created=false;
  try{
    await sql.connect();await sql.query('CREATE SCHEMA "'+schema+'"');created=true;
    const directory=resolve("prisma/migrations");
    for(const migration of (await readdir(directory,{withFileTypes:true})).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))await sql.query(await readFile(resolve(directory,migration.name,"migration.sql"),"utf8"));
    const salon=getSalon();await seedDemoCatalog(database,{...salon,policy:{...salon.policy,minimumLeadMinutes:0,prepaymentMode:payments?"PERCENTAGE":"DISABLED",prepaymentFixedMinor:0,prepaymentPercentage:payments?25:0}});
    await database.salonSettings.update({where:{id:"salon"},data:{name:"QA Ромео — проверка",email:"salon@example.invalid"}});
    await provisionFirstAdmin({...credentials,name:"QA владелец"},{database});
    const url=new URL(connectionString);url.searchParams.set("schema",schema);
    server=spawn(process.execPath,[resolve("node_modules/next/dist/bin/next"),"start","--hostname","127.0.0.1","--port","3001"],{env:{...process.env,DATABASE_URL:url.toString(),APP_ENV:production?"production":"demo",PAYMENT_MODE:payments?"TEST":"DISABLED",PAYMENT_WEBHOOK_SECRET:randomBytes(32).toString("base64url")},stdio:"ignore",windowsHide:true});
    server.on("error",()=>{});
    current="Запуск QA сервера";
    let ready=false;for(let i=0;i<50;i++){if(server.exitCode!==null)throw Error("QA port occupied or build missing");try{if((await fetch(origin+"/api/catalog")).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert.ok(ready);
    current="HTTP защита";
    const health=await fetch(origin+"/api/health");assert.equal(health.status,200);assert.equal(health.headers.get("cache-control"),"no-store");assert.deepEqual(await health.json(),{status:"ok"});
    const about=await fetch(origin+"/about");const html=await about.text();assert.match(html,/<title>О салоне · QA Ромео — проверка<\/title>/);assert.match(html,/mailto:salon@example.invalid/);
    const redirect=await fetch(origin+"/admin",{redirect:"manual"});
    if(redirect.status===307)assert.equal(new URL(redirect.headers.get("location")!,origin).pathname,"/admin/login");
    else { assert.equal(redirect.status,200);assert.match(await redirect.text(),/http-equiv="refresh"[^>]*\/admin\/login/); }
    for(const section of ["overview","customers","payments","settings","audit"]){const response=await fetch(origin+"/api/admin/data?section="+section);assert.equal(response.status,401);assert.match(response.headers.get("cache-control")??"",/no-store/);}
    current="HTTP вход";
    if(production)assert.equal((await fetch(origin+"/api/admin/login",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(credentials)})).status,403);
    const login=await fetch(origin+"/api/admin/login",{method:"POST",headers:{...proxyHeaders,origin:browserOrigin,"content-type":"application/json"},body:JSON.stringify(credentials)});console.info("QA login status: "+login.status);assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    if(production)assert.match(cookie,/; Secure/);
    const headers={...proxyHeaders,cookie:cookie.split(";")[0],origin:browserOrigin,"content-type":"application/json"};
    current="HTTP чтение разделов";
    const date=addCalendarDays(salonDateString(new Date(),salon.timezone),1);
    for(const query of ["section=overview","section=catalog","section=schedule&masterId="+demoId("master","alex"),"section=appointments&from="+date+"&to="+date,"section=customers","section=payments","section=settings","section=audit"]){const response=await fetch(origin+"/api/admin/data?"+query,{headers});assert.equal(response.status,200);const body=await response.text();assert.doesNotMatch(body,/passwordHash|tokenHash|publicAccessTokenHash/);}
    current="HTTP запись, повтор и выход";
    const input={target:"catalog",input:{op:"category.create",idempotencyKey:randomUUID(),data:{slug:"qa-browser-category",name:"QA категория браузера"}}};
    const responses=await Promise.all(Array.from({length:2},()=>fetch(origin+"/api/admin/mutate",{method:"POST",headers,body:JSON.stringify(input)})));assert.ok(responses.every(r=>r.status===200));assert.equal(await database.serviceCategory.count({where:{slug:"qa-browser-category"}}),1);
    const foreign=await fetch(origin+"/api/admin/mutate",{method:"POST",headers:{...headers,origin:"https://foreign.example"},body:JSON.stringify(input)});assert.equal(foreign.status,403);
    assert.equal((await fetch(origin+"/api/admin/logout",{method:"POST",headers})).status,200);assert.equal((await fetch(origin+"/api/admin/session",{headers})).status,401);
    console.info("HTTP QA: health, сохранённые название/email, защита, вход, 8 разделов, идемпотентная запись, Origin и выход — пройдено."+(production?" HTTPS-прокси и Secure cookie проверены.":""));
    if(process.argv.includes("--serve")){
      console.info("Изолированный браузерный QA сервер: "+origin+"/admin/login. Введите stop для остановки и очистки.");
      await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);process.stdin.off("data",onData);process.stdin.pause();resolve();};
        const onData=(chunk:Buffer)=>{if(chunk.toString().trim()==="stop")finish();};
        const timer=setTimeout(finish,15*60000);process.stdin.on("data",onData);process.stdin.resume();
        process.once("SIGINT",finish);process.once("SIGTERM",finish);
      });
    }
    current="HTTP ошибка базы и восстановление";
    await sql.query('ALTER TABLE "SalonSettings" RENAME TO "QASettingsUnavailable"');
    try {
      const unavailable=await fetch(origin+"/api/health");assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{status:"unavailable"});
      assert.equal((await fetch(origin+"/api/catalog")).status,503);
      assert.equal((await fetch(origin+"/")).status,200);
    } finally { await sql.query('ALTER TABLE "QASettingsUnavailable" RENAME TO "SalonSettings"'); }
    assert.equal((await fetch(origin+"/api/health")).status,200);
    console.info("HTTP QA: недоступность таблиц, безопасный 503 и восстановление — пройдено.");
  }finally{
    if(server&&!server.killed){server.kill();await new Promise(r=>setTimeout(r,500));}
    await database.$disconnect();if(created&&/^qa_romeo_admin_http_[a-f0-9]{32}$/.test(schema))await sql.query('DROP SCHEMA "'+schema+'" CASCADE');await sql.end();
    console.info("Изолированная QA схема удалена; основная база не изменена.");
  }
}
main().catch(()=>{console.error("HTTP QA не пройден: "+current+". Секреты подключения не выводятся.");process.exitCode=1;});
