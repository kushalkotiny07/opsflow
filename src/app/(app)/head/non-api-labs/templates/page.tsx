import { NonApiLabMessageFlow } from "@/components/head/NonApiLabMessageFlow";
import { PollDefinitionsPanel } from "@/components/head/PollDefinitionsPanel";

export const metadata = { title: "Provider Messages | OpsFlow" };

export default function ProviderTemplatesPage() {
  return (
    <>
      <NonApiLabMessageFlow />
      {/* The message says what we ask; this says how they answer and what they
          hear back. They belong on one screen. */}
      <PollDefinitionsPanel />
    </>
  );
}
