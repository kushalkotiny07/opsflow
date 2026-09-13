import { redirect } from "next/navigation";

// Provider Communication is a sidebar group, not a page of its own — land
// anyone who hits the bare route on the first sub-page.
export default function NonApiLabsPage() {
  redirect("/head/non-api-labs/lab-config");
}
