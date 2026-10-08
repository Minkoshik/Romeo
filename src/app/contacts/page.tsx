import { BookingGuard } from "@/components/booking-flow-common";
import { ContactsForm } from "@/components/booking-checkout";
export default function ContactsPage() { return <BookingGuard requiring="time"><ContactsForm/></BookingGuard>; }
