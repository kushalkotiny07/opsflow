import { SlaBreachList } from "@/components/head/SlaBreachList";

export const metadata = { title: "SLA Breaches | OpsFlow" };

/**
 * The role guard and page frame live in the module layout, same as the other
 * Provider Communication sub-pages.
 */
export default function SlaBreachesPage() {
  return <SlaBreachList />;
}
