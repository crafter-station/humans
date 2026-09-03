"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { NativeSelect } from "@repo/ui/components/native-select";
import { Textarea } from "@repo/ui/components/textarea";
import Link from "next/link";
import { useState } from "react";

import styles from "./profile-request.module.css";

export default function ProfileRequestPage() {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch("/api/public/profile-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileReference: String(data.get("profileReference") ?? "").trim(),
          kind: data.get("kind"),
          requesterEmail: String(data.get("requesterEmail") ?? "").trim(),
          details: String(data.get("details") ?? "").trim(),
        }),
      });
      if (response.ok) {
        event.currentTarget.reset();
        setMessage(
          "Request received. An Operator will verify that you represent the person before reviewing or hiding the Profile.",
        );
      } else if (response.status === 429) {
        setMessage("Too many requests. Wait a minute before trying again.");
      } else {
        setMessage("Check every field and try again.");
      }
    } catch {
      setMessage("The request could not be submitted. Try again shortly.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <Link className={styles.wordmark} href="/">
          Humans
        </Link>
        <Link className={styles.back} href="/">
          Back to product
        </Link>
      </nav>
      <div className={styles.layout}>
        <header className={styles.intro}>
          <p className={styles.eyebrow}>Profile control</p>
          <h1>Correct or remove your Profile.</h1>
          <p>
            No Humans account is required. After an Operator verifies that you
            represent the person, a matching Profile is removed from searches
            while the request is reviewed.
          </p>
          <aside>
            Humans never confirms whether a Profile reference exists and never
            returns Profile or Contact Detail data from this form.
          </aside>
        </header>
        <form className={styles.form} onSubmit={submit}>
          <label htmlFor="kind">
            Request
            <NativeSelect id="kind" name="kind" defaultValue="correction">
              <option value="correction">Correct Profile details</option>
              <option value="removal">Remove the Profile</option>
            </NativeSelect>
          </label>
          <label htmlFor="profileReference">
            Profile reference
            <Input
              id="profileReference"
              name="profileReference"
              required
              autoComplete="off"
              aria-describedby="reference-help"
            />
            <span id="reference-help">
              Use the opaque reference supplied with the Profile, not a name,
              email address, or social handle.
            </span>
          </label>
          <label htmlFor="requesterEmail">
            Your email
            <Input
              id="requesterEmail"
              name="requesterEmail"
              type="email"
              required
              autoComplete="email"
            />
          </label>
          <label htmlFor="details">
            What should change?
            <Textarea
              id="details"
              name="details"
              required
              minLength={10}
              maxLength={2_000}
              rows={7}
              placeholder="Describe the correction or why this Profile should be removed."
            />
          </label>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit private request"}
          </Button>
          {message && <p role="status">{message}</p>}
        </form>
      </div>
    </main>
  );
}
