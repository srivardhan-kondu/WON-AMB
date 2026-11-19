import { redirect } from "next/navigation";

/** Bookings are made only at the front desk. The root URL opens the desk (which asks staff to log in). */
export default function Home() {
  redirect("/desk");
}
