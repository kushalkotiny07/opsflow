import { ProviderOrdersPage } from "@/components/head/ProviderOrdersPage";

export const metadata = { title: "Provider Orders | OpsFlow" };

export default async function ProviderBoardDetailPage({ params }: { params: Promise<{ labId: string }> }) {
  const { labId } = await params;
  return <ProviderOrdersPage labId={Number(labId)} />;
}
