import { NonApiLabConfigPanel } from "@/components/head/NonApiLabConfigPanel";
import { NonApiWorkflowTimeline } from "@/components/head/NonApiWorkflowTimeline";
import { SlaDeadlinesSection } from "@/components/head/SlaDeadlinesSection";

export const metadata = { title: "Lab Config | OpsFlow" };

export default function LabConfigPage() {
  return (
    <>
      <NonApiLabConfigPanel />
      <SlaDeadlinesSection />
      <NonApiWorkflowTimeline />
    </>
  );
}
