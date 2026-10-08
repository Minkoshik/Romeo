import type { Metadata } from "next";
import { AppointmentScreen } from "@/components/appointment-view";

export const metadata: Metadata = { title:"Ваша запись", robots:{index:false,follow:false}, referrer:"no-referrer" };
export default async function AppointmentPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  return <AppointmentScreen id={id}/>;
}
