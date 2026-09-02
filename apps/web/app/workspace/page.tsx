import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { WorkspaceProvisioner } from "./workspace-provisioner";
import { ProfileOnboarding } from "./profile-onboarding";
import styles from "./workspace.module.css";

export default async function WorkspacePage() {
  await auth.protect();

  return (
    <main className={styles.page}>
      <WorkspaceProvisioner />
      <header className={styles.header}>
        <span className={styles.wordmark}>Humans</span>
        <div className={styles.account}>
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      </header>
      <Suspense fallback={null}>
        <ProfileOnboarding />
      </Suspense>
    </main>
  );
}
