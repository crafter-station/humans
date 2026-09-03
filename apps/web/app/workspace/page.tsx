import { Suspense } from "react";

import { BillingPanel } from "./billing-panel";
import { WorkspaceProvisioner } from "./workspace-provisioner";
import { ProfileOnboarding } from "./profile-onboarding";
import styles from "./workspace.module.css";

export default function WorkspacePage() {
  return (
    <div className={styles.page}>
      <WorkspaceProvisioner>
        <BillingPanel />
        <Suspense fallback={null}>
          <ProfileOnboarding />
        </Suspense>
      </WorkspaceProvisioner>
    </div>
  );
}
