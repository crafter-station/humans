import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import { Button } from "@repo/ui/components/button";
import Link from "next/link";

import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.wordmark}>Humans</span>
        <div className={styles.actions}>
          <Link className={styles.requestLink} href="/profile-request">
            Correct or remove a Profile
          </Link>
          <Show when="signed-out">
            <SignInButton>
              <Button className={styles.textButton} type="button">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton>
              <Button className={styles.primaryButton} type="button">
                Join Humans
              </Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Button
              className={styles.primaryButton}
              render={<Link href="/workspace" />}
            >
              Open workspace
            </Button>
          </Show>
        </div>
      </nav>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>The protected LATAM builder directory</p>
        <h1>Find the people behind the code.</h1>
        <p className={styles.intro}>
          Discover experienced builders across Latin America through current,
          sourced evidence. Profiles stay inside authenticated Humans
          workspaces.
        </p>
        <Show when="signed-out">
          <SignUpButton>
            <Button className={styles.heroButton} type="button">
              Create your workspace
            </Button>
          </SignUpButton>
        </Show>
        <Show when="signed-in">
          <Button
            className={styles.heroButton}
            render={<Link href="/workspace" />}
          >
            Continue to Humans
          </Button>
        </Show>
      </section>

      <aside className={styles.note}>
        <span>01</span>
        <p>
          Not a public index. Search results and Profile data are available only
          to authenticated Organization Members.
        </p>
      </aside>
    </main>
  );
}
