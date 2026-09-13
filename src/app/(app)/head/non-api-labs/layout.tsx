import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";

export const metadata = { title: "Provider Communication | OpsFlow" };

/**
 * Shared guard + page frame for the Provider Communication sub-pages
 * (Lab Config, Task Rules, Templates). Each child page only renders its
 * own panel; the role check and padding live here so they stay identical.
 */
export default async function ProviderCommunicationLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== UserRole.OPS_HEAD) redirect("/agent");
  return <div className="p-6 max-w-7xl mx-auto">{children}</div>;
}
