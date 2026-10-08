import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AdminError } from "./admin-auth";
import { adminReadTransaction, adminMutationTransaction, adminAudit, assertUpdatedAt, adminAppointmentSelect, toAdminAppointment, type AdminDatabaseOptions } from "./admin-booking-repository";
import { addCalendarDays, salonDateString, salonDateTimeToInstant } from "./salon-time";

const uuid = z.uuid();
const text = z.string().trim().max(10000);
const image = z.string().trim().max(2048).refine(v => !v || /^\/(?!\/)/.test(v) || /^https:\/\/[^\s]+$/.test(v));
export const adminSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80), address: z.string().trim().min(1).max(200), phone: z.string().trim().min(3).max(40),
  email: z.union([z.literal(""), z.email()]).default(""), logoUrl: image.default(""),
  currency: z.string().regex(/^[A-Z]{3}$/).refine(v => { try { return Intl.supportedValuesOf("currency").includes(v) && new Intl.NumberFormat("en", {style:"currency",currency:v}).resolvedOptions().maximumFractionDigits === 2; } catch { return false; } }),
  timezone: z.string().max(64).refine(v => { try { new Intl.DateTimeFormat("en", {timeZone:v}).format(); return true; } catch { return false; } }),
  bookingHorizonDays: z.number().int().min(1).max(365), minimumLeadMinutes: z.number().int().min(0).max(10080),
  slotStepMinutes: z.number().int().min(5).max(60).refine(v => v % 5 === 0), holdDurationMinutes: z.number().int().min(1).max(60), bufferMinutes: z.number().int().min(0).max(120),
  prepaymentMode: z.enum(["DISABLED","FIXED","PERCENTAGE"]), prepaymentFixedMinor: z.number().int().min(0).max(100000000), prepaymentPercentageBps: z.number().int().min(0).max(10000),
  cancellationLeadMinutes: z.number().int().min(0).max(43200), rescheduleLeadMinutes: z.number().int().min(0).max(43200),
  bookingTerms: z.string().trim().min(1).max(20000), privacyTerms: z.string().trim().min(1).max(20000),
}).strict().refine(v => v.prepaymentMode==="DISABLED" || (v.prepaymentMode==="FIXED"?v.prepaymentFixedMinor>0:v.prepaymentPercentageBps>0),"Укажите положительную предоплату или отключите её.");
export type AdminSettingsInput = z.input<typeof adminSettingsSchema>;
const existing = {idempotencyKey:uuid, id:uuid, expectedUpdatedAt:z.iso.datetime({offset:true})};
export const adminManagementMutationSchema = z.discriminatedUnion("action", [
  z.object({action:z.literal("customerNotes"), ...existing, adminNotes:text}).strict(),
  z.object({action:z.literal("paymentReview"), ...existing, note:z.string().trim().min(3).max(2000)}).strict(),
  z.object({action:z.literal("settings"), idempotencyKey:uuid, expectedUpdatedAt:z.iso.datetime({offset:true}), data:adminSettingsSchema}).strict(),
]);
function settingsView(row: Awaited<ReturnType<Prisma.TransactionClient["salonSettings"]["findUniqueOrThrow"]>>) {
  return {name:row.name,address:row.address,phone:row.phone,email:row.email??"",logoUrl:row.logoUrl??"",currency:row.currency,timezone:row.timezone,
    bookingHorizonDays:row.bookingHorizonDays,minimumLeadMinutes:row.minimumLeadMinutes,slotStepMinutes:row.slotStepMinutes,holdDurationMinutes:row.holdDurationMinutes,bufferMinutes:row.bufferMinutes,
    prepaymentMode:row.prepaymentMode,prepaymentFixedMinor:row.prepaymentFixedMinor??0,prepaymentPercentageBps:row.prepaymentPercentageBps??0,
    cancellationLeadMinutes:row.cancellationLeadMinutes,rescheduleLeadMinutes:row.rescheduleLeadMinutes,bookingTerms:row.bookingTerms,privacyTerms:row.privacyTerms,
    updatedAt:row.updatedAt.toISOString(),isDemo:row.isDemo};
}
export type AdminSettings = ReturnType<typeof settingsView>;
export async function getAdminManagement(token: string|null, section: string, filters: {search?:string;id?:string;status?:string;needsAttention?:boolean;from?:string;to?:string} = {}, options:AdminDatabaseOptions = {}) {
  return adminReadTransaction(token,options,async(tx,_actor,now)=>{
    if(section === "settings") return {settings:settingsView(await tx.salonSettings.findUniqueOrThrow({where:{id:"salon"}}))};
    if(section === "customers") {
      const search=filters.search?.trim();
      const customers=await tx.customer.findMany({where:{...(filters.id?{id:filters.id}:{}),...(search?{OR:[{name:{contains:search,mode:"insensitive"}},{phoneNormalized:{contains:search}},{email:{contains:search,mode:"insensitive"}}]}:{})},
        select:{id:true,name:true,phoneNormalized:true,email:true,adminNotes:true,updatedAt:true,_count:{select:{appointments:true}}},orderBy:[{updatedAt:"desc"},{id:"asc"}],take:101});
      const history=filters.id ? (await tx.appointment.findMany({where:{customerId:filters.id},select:adminAppointmentSelect,orderBy:{startsAt:"desc"},take:200})).map(toAdminAppointment):[];
      return {customers:customers.slice(0,100).map(r=>({...r,updatedAt:r.updatedAt.toISOString()})),history,truncated:customers.length>100};
    }
    if(section === "payments") {
      const validStatus=z.enum(["PENDING","SUCCEEDED","FAILED","CANCELLED","EXPIRED","PARTIALLY_REFUNDED","REFUNDED"]).safeParse(filters.status);
      if(filters.status&&!validStatus.success)throw new AdminError("Проверьте статус платежа.",400);
      const rows=await tx.payment.findMany({where:{...(filters.needsAttention?{needsAttention:true}:{}),...(validStatus.success?{status:validStatus.data}:{})},select:{id:true,appointmentId:true,provider:true,mode:true,providerPaymentId:true,status:true,amountMinor:true,refundedAmountMinor:true,currency:true,needsAttention:true,attentionReason:true,failureCode:true,paidAt:true,refundedAt:true,updatedAt:true,createdAt:true,appointment:{select:{number:true,customerNameSnapshot:true}}},orderBy:[{createdAt:"desc"},{id:"asc"}],take:201});
      return {payments:rows.slice(0,200).map(r=>({...r,createdAt:r.createdAt.toISOString(),updatedAt:r.updatedAt.toISOString(),paidAt:r.paidAt?.toISOString()??null,refundedAt:r.refundedAt?.toISOString()??null})),truncated:rows.length>200};
    }
    if(section === "audit") {
      const rows=await tx.auditLog.findMany({include:{actor:{select:{name:true,emailNormalized:true}}},orderBy:[{createdAt:"desc"},{id:"asc"}],take:200});
      return {audit:rows.map(r=>({...r,createdAt:r.createdAt.toISOString()}))};
    }
    if(section !== "overview")throw new AdminError("Раздел не найден.",404);
    const settings=await tx.salonSettings.findUniqueOrThrow({where:{id:"salon"}});
    const today=salonDateString(now,settings.timezone);
    const from=salonDateTimeToInstant(today,"00:00",settings.timezone)!;
    const until=salonDateTimeToInstant(addCalendarDays(today,1),"00:00",settings.timezone)!;
    const [appointments,next,confirmedCount,attentionCount,prepayments]=await Promise.all([
      tx.appointment.findMany({where:{startsAt:{gte:from,lt:until}},select:adminAppointmentSelect,orderBy:{startsAt:"asc"},take:100}),
      tx.appointment.findMany({where:{startsAt:{gte:now},status:"CONFIRMED"},select:adminAppointmentSelect,orderBy:{startsAt:"asc"},take:10}),
      tx.appointment.count({where:{status:"CONFIRMED",startsAt:{gte:from,lt:until}}}),tx.payment.count({where:{needsAttention:true}}),
      tx.payment.groupBy({by:["currency","mode"],where:{status:{in:["SUCCEEDED","PARTIALLY_REFUNDED","REFUNDED"]},paidAt:{gte:from,lt:until}},_sum:{amountMinor:true,refundedAmountMinor:true}}),
    ]);
    return {today,timezone:settings.timezone,appointments:appointments.map(toAdminAppointment),next:next.map(toAdminAppointment),confirmedCount,attentionCount,
      prepayments:prepayments.map(r=>({currency:r.currency,mode:r.mode,amountMinor:(r._sum.amountMinor??0)-(r._sum.refundedAmountMinor??0)}))};
  });
}
export async function mutateAdminManagement(token:string|null,input:unknown,options:AdminDatabaseOptions={}) {
  const parsed=adminManagementMutationSchema.safeParse(input);
  if(!parsed.success)throw new AdminError("Проверьте поля и актуальность данных.",400);
  const request=parsed.data;
  return adminMutationTransaction(token,request,options,async(tx,actor,now)=>{
    if(request.action === "settings") {
      if(actor.role!=="OWNER")throw new AdminError("Настройки изменяет только владелец салона.",403);
      const before=await tx.salonSettings.findUniqueOrThrow({where:{id:"salon"}});assertUpdatedAt(before.updatedAt,request.expectedUpdatedAt);
      if(before.timezone!==request.data.timezone && await tx.appointment.count({where:{occupiedUntil:{gt:now},status:{in:["CONFIRMED","WAITING_PAYMENT"]}}}))throw new AdminError("Сначала завершите или перенесите действующие записи перед сменой часового пояса.",409);
      const after=await tx.salonSettings.update({where:{id:"salon"},data:{...request.data,prepaymentFixedMinor:request.data.prepaymentMode==="FIXED"?request.data.prepaymentFixedMinor:null,prepaymentPercentageBps:request.data.prepaymentMode==="PERCENTAGE"?request.data.prepaymentPercentageBps:null,email:request.data.email||null,logoUrl:request.data.logoUrl||null,updatedAt:new Date(Math.max(now.getTime(),before.updatedAt.getTime()+1))}});
      await adminAudit(tx,actor,"SETTINGS_UPDATE","SalonSettings","salon",request.idempotencyKey,settingsView(before),settingsView(after));
      return {settings:settingsView(after)};
    }
    if(request.action === "customerNotes") {
      const before=await tx.customer.findUnique({where:{id:request.id}});if(!before)throw new AdminError("Клиент не найден.",404);assertUpdatedAt(before.updatedAt,request.expectedUpdatedAt);
      const after=await tx.customer.update({where:{id:request.id},data:{adminNotes:request.adminNotes||null,updatedAt:new Date(Math.max(now.getTime(),before.updatedAt.getTime()+1))}});
      await adminAudit(tx,actor,"CUSTOMER_NOTES","Customer",request.id,request.idempotencyKey,{adminNotes:before.adminNotes},{adminNotes:after.adminNotes});return {id:after.id};
    }
    const payment=await tx.payment.findUnique({where:{id:request.id}});if(!payment)throw new AdminError("Платёж не найден.",404);assertUpdatedAt(payment.updatedAt,request.expectedUpdatedAt);
    // A review is an audit note, never a refund or a fake successful payment.
    await adminAudit(tx,actor,"PAYMENT_REVIEW","Payment",request.id,request.idempotencyKey,{status:payment.status,needsAttention:payment.needsAttention},{note:request.note,status:payment.status,needsAttention:payment.needsAttention});
    return {id:payment.id};
  });
}
