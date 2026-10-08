import { BookingGuard } from "@/components/booking-flow-common";
import { DateSelection } from "@/components/date-time-selection";

export default function DatePage() {
  return <BookingGuard requiring="master"><DateSelection /></BookingGuard>;
}
