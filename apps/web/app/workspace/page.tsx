import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

import { WorkspaceProvisioner } from "./workspace-provisioner";
import styles from "./workspace.module.css";

export default function WorkspacePage() {
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
      <section className={styles.content}>
        <p className={styles.eyebrow}>Protected workspace</p>
        <h1>Welcome to your workspace.</h1>
        <p>
          Search and shared workspace tools will arrive here next. Your Member
          session and Organization boundary are being prepared securely.
        </p>
      </section>
    </main>
  );
}
