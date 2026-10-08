import { BookingGuard } from "@/components/booking-flow-common";
import { ReviewBooking } from "@/components/booking-checkout";
export default function ReviewPage() { return <BookingGuard requiring="contacts"><ReviewBooking/></BookingGuard>; }
