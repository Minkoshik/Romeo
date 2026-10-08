import { BookingGuard } from "@/components/booking-flow-common";
import { TimeSelection } from "@/components/date-time-selection";

export default function TimePage() {
  return <BookingGuard requiring="date"><TimeSelection /></BookingGuard>;
}
