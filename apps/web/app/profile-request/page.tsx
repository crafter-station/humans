"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { NativeSelect } from "@repo/ui/components/native-select";
import { Textarea } from "@repo/ui/components/textarea";
import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import { env } from "@/env";
import styles from "./profile-request.module.css";
import { profileRequestTurnstileAction } from "./turnstile";

type TurnstileWidgetId = string;
type TurnstileApi = {
  ready: (callback: () => void) => void;
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "always";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "refresh-expired": "never";
      "refresh-timeout": "never";
      "response-field": false;
      retry: "auto";
      size: "compact";
      theme: "auto";
      "timeout-callback": () => void;
      "unsupported-callback": () => void;
    },
  ) => TurnstileWidgetId;
  remove: (widgetId: TurnstileWidgetId) => void;
  reset: (widgetId: TurnstileWidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export default function ProfileRequestPage() {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileStatus, setTurnstileStatus] = useState(
    "Security check is loading.",
  );
  const turnstileContainer = useRef<HTMLDivElement>(null);
  const turnstileWidget = useRef<TurnstileWidgetId | null>(null);

  const resetTurnstile = (status: string) => {
    setTurnstileToken(null);
    setTurnstileStatus(status);
    const widgetId = turnstileWidget.current;
    if (widgetId === null) return;
    try {
      window.turnstile?.reset(widgetId);
    } catch {
      setTurnstileStatus(
        "Security check could not restart. Refresh the page and try again.",
      );
    }
  };

  const renderTurnstile = () => {
    const turnstile = window.turnstile;
    if (!turnstile) {
      setTurnstileStatus(
        "Security check could not load. Refresh the page and try again.",
      );
      return;
    }
    turnstile.ready(() => {
      const container = turnstileContainer.current;
      if (!container || turnstileWidget.current !== null) return;
      setTurnstileStatus("Security check is in progress.");
      try {
        turnstileWidget.current = turnstile.render(container, {
          sitekey: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
          action: profileRequestTurnstileAction,
          appearance: "always",
          callback: (token) => {
            setTurnstileToken(token);
            setTurnstileStatus("Security check complete. You can submit.");
          },
          "error-callback": () => {
            setTurnstileToken(null);
            setTurnstileStatus(
              "Security check failed and will retry automatically.",
            );
          },
          "expired-callback": () => {
            resetTurnstile(
              "Security check expired and was restarted. Complete it again.",
            );
          },
          "refresh-expired": "never",
          "refresh-timeout": "never",
          "response-field": false,
          retry: "auto",
          size: "compact",
          theme: "auto",
          "timeout-callback": () => {
            resetTurnstile(
              "Security check timed out and was restarted. Complete it again.",
            );
          },
          "unsupported-callback": () => {
            setTurnstileToken(null);
            setTurnstileStatus(
              "This browser cannot run the security check. Try a supported browser.",
            );
          },
        });
      } catch {
        setTurnstileToken(null);
        setTurnstileStatus(
          "Security check could not load. Refresh the page and try again.",
        );
      }
    });
  };

  useEffect(
    () => () => {
      const widgetId = turnstileWidget.current;
      if (widgetId === null) return;
      try {
        window.turnstile?.remove(widgetId);
      } catch {
        // The third-party widget may already have removed itself during unload.
      }
      turnstileWidget.current = null;
    },
    [],
  );

  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const token = turnstileToken;
    if (!token) {
      setMessage("Complete the security check before submitting.");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const data = new FormData(form);
      const response = await fetch("/api/public/profile-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileReference: String(data.get("profileReference") ?? "").trim(),
          kind: data.get("kind"),
          requesterEmail: String(data.get("requesterEmail") ?? "").trim(),
          details: String(data.get("details") ?? "").trim(),
          turnstileToken: token,
        }),
      });
      if (response.ok) {
        form.reset();
        setMessage(
          "Request received. An Operator will verify that you represent the person before reviewing or hiding the Profile.",
        );
      } else if (response.status === 429) {
        setMessage("Too many requests. Wait a minute before trying again.");
      } else if (response.status === 400) {
        setMessage(
          "The security check expired or failed. Complete the new check and try again.",
        );
      } else if (response.status === 503) {
        setMessage(
          "The request service is temporarily unavailable. Complete the new security check and try again shortly.",
        );
      } else {
        setMessage("Check every field and try again.");
      }
    } catch {
      setMessage("The request could not be submitted. Try again shortly.");
    } finally {
      setSubmitting(false);
      resetTurnstile(
        "Security check reset. Complete it before submitting again.",
      );
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
        <form className={styles.form} onSubmit={submit} aria-busy={submitting}>
          <Script
            id="cloudflare-turnstile"
            src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
            strategy="afterInteractive"
            onReady={renderTurnstile}
            onError={() => {
              setTurnstileToken(null);
              setTurnstileStatus(
                "Security check could not load. Refresh the page and try again.",
              );
            }}
          />
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
          <div className={styles.securityCheck}>
            <div ref={turnstileContainer} className={styles.turnstileWidget} />
            <p
              id="turnstile-status"
              className={styles.securityStatus}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {turnstileStatus}
            </p>
          </div>
          <Button
            type="submit"
            disabled={submitting || turnstileToken === null}
            aria-describedby="turnstile-status"
            data-submitting={submitting || undefined}
          >
            {submitting ? "Submitting..." : "Submit private request"}
          </Button>
          {message && <p role="status">{message}</p>}
        </form>
      </div>
    </main>
  );
}
