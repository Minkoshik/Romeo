import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { adminSettingsSchema, adminManagementMutationSchema } from "../src/lib/admin-management-repository";
import { adminAppointmentMutationSchema } from "../src/lib/admin-booking-repository";
import { GET } from "../src/app/api/admin/data/route";
import { POST } from "../src/app/api/admin/mutate/route";
const origin="http://127.0.0.1:3000";
const settings={name:"Салон",address:"Адрес",phone:"+79165000001",email:"",logoUrl:"",currency:"RUB",timezone:"Europe/Moscow",bookingHorizonDays:60,minimumLeadMinutes:120,slotStepMinutes:30,holdDurationMinutes:10,bufferMinutes:15,prepaymentMode:"DISABLED",prepaymentFixedMinor:0,prepaymentPercentageBps:0,cancellationLeadMinutes:1440,rescheduleLeadMinutes:1440,bookingTerms:"Условия",privacyTerms:"Данные"};
test("All admin data and mutation sections reject anonymous access with no-store",async()=>{
  for(const section of ["overview","appointments","catalog","schedule","customers","payments","settings","audit"]){const response=await GET(new Request(origin+"/api/admin/data?section="+section));assert.equal(response.status,401);assert.equal(response.headers.get("cache-control"),"no-store");}
  const request=new Request(origin+"/api/admin/mutate",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({target:"management",input:{action:"settings",data:settings}})});assert.equal((await POST(request)).status,401);
  assert.equal((await POST(new Request(origin+"/api/admin/mutate",{method:"POST",headers:{origin:"https://foreign.example"}}))).status,403);
});
test("Settings agree with public catalog limits and cannot forge payment or environment state",()=>{
  assert.ok(adminSettingsSchema.safeParse(settings).success);
  for(const patch of [{name:"a".repeat(81)},{slotStepMinutes:120},{bufferMinutes:240},{currency:"JPY"},{currency:"XYZ"},{timezone:"bad"},{logoUrl:"javascript:alert(1)"},{prepaymentMode:"FIXED",prepaymentFixedMinor:0},{prepaymentMode:"PERCENTAGE",prepaymentPercentageBps:10001},{isDemo:false},{allowCustomerCancellation:true},{paymentMode:"LIVE"}])assert.equal(adminSettingsSchema.safeParse({...settings,...patch}).success,false);
  assert.equal(adminManagementMutationSchema.safeParse({action:"refund",idempotencyKey:randomUUID(),id:randomUUID(),paid:true}).success,false);
});
test("Appointment operations require revision and reason and reject browser-supplied prices/statuses",()=>{
  const input={action:"reschedule",idempotencyKey:randomUUID(),id:randomUUID(),expectedUpdatedAt:new Date().toISOString(),masterId:randomUUID(),date:"2026-10-12",time:"12:00",reason:"По просьбе клиента"};
  assert.equal(adminAppointmentMutationSchema.safeParse(input).success,true);
  for(const patch of [{reason:""},{expectedUpdatedAt:""},{date:"2026-02-30"},{paidMinor:100},{totalPriceMinor:1}])assert.equal(adminAppointmentMutationSchema.safeParse({...input,...patch}).success,false);
});
