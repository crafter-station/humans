import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";

import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.wordmark}>Humans</span>
        <div className={styles.actions}>
          <Show when="signed-out">
            <SignInButton>
              <button className={styles.textButton} type="button">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button className={styles.primaryButton} type="button">
                Join Humans
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link className={styles.primaryButton} href="/workspace">
              Open workspace
            </Link>
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
            <button className={styles.heroButton} type="button">
              Create your workspace
            </button>
          </SignUpButton>
        </Show>
        <Show when="signed-in">
          <Link className={styles.heroButton} href="/workspace">
            Continue to Humans
          </Link>
        </Show>
      </section>

      <aside className={styles.note}>
        <span>01</span>
        <p>
          Not a public index. Search results and Profile data are available
          only to authenticated Organization Members.
        </p>
      </aside>
    </main>
  );
}
