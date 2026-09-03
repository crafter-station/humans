"use client";

import { useOrganization } from "@clerk/nextjs";
import { Button } from "@repo/ui/components/button";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import styles from "./workspace.module.css";

type BillingOverview = {
  plan: "free" | "pro";
  availableCredits: number;
  status: string;
  renewalBoundary: string | null;
  cancelAtPeriodEnd: boolean;
  canManageBilling: boolean;
};

const readableStatus = (status: string) => status.replaceAll("_", " ");

const readableDate = (value: string | null) =>
  value === null
    ? "Pending"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(value));

export function BillingPanel() {
  const { organization } = useOrganization();
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const requestSequence = useRef(0);
  const loadBilling = useEffectEvent(async (signal?: AbortSignal) => {
    const request = ++requestSequence.current;
    try {
      const response = await fetch("/api/billing", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Billing is temporarily unavailable");
      const result = (await response.json()) as BillingOverview;
      if (signal?.aborted || request !== requestSequence.current) return;
      setBilling(result);
      setMessage(null);
    } catch (error) {
      if (!signal?.aborted && request === requestSequence.current) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Billing is temporarily unavailable",
        );
      }
    }
  });

  useEffect(() => {
    if (!organization?.id) return;
    const controller = new AbortController();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const refresh = () => void loadBilling(controller.signal);
    const returnedFromBilling =
      new URLSearchParams(window.location.search).has("billing") ||
      sessionStorage.getItem("humans:billing-return") === organization.id;

    setBilling(null);
    setMessage(null);
    refresh();
    if (returnedFromBilling) {
      for (const delay of [750, 2_000, 5_000]) {
        timers.push(setTimeout(refresh, delay));
      }
      timers.push(
        setTimeout(() => {
          sessionStorage.removeItem("humans:billing-return");
          const url = new URL(window.location.href);
          url.searchParams.delete("billing");
          window.history.replaceState(null, "", url);
        }, 5_100),
      );
    }
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("humans:credits-changed", refresh);
    return () => {
      requestSequence.current += 1;
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("humans:credits-changed", refresh);
    };
  }, [organization?.id]);

  const openBilling = async (action: "checkout" | "portal") => {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(`/api/billing/${action}`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        url?: string;
        error?: { message?: string };
      };
      if (!response.ok || !result.url)
        throw new Error(result.error?.message ?? "Billing is unavailable");
      if (organization?.id) {
        sessionStorage.setItem("humans:billing-return", organization.id);
      }
      window.location.assign(result.url);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Billing is unavailable",
      );
      setBusy(null);
    }
  };

  if (!organization?.id) return null;

  return (
    <section className={styles.billingPanel} aria-label="Organization billing">
      {billing ? (
        <>
          <div className={styles.billingMetric}>
            <span>Plan</span>
            <strong>{billing.plan === "pro" ? "Pro" : "Free"}</strong>
          </div>
          <div className={styles.billingMetric}>
            <span>Available</span>
            <strong>{billing.availableCredits.toLocaleString()} Credits</strong>
          </div>
          <div className={styles.billingMetric}>
            <span>Status</span>
            <strong>{readableStatus(billing.status)}</strong>
          </div>
          <div className={styles.billingMetric}>
            <span>{billing.cancelAtPeriodEnd ? "Access until" : "Renews"}</span>
            <strong>{readableDate(billing.renewalBoundary)}</strong>
          </div>
          {billing.canManageBilling ? (
            <div className={styles.billingActions}>
              {billing.plan === "free" ? (
                <Button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void openBilling("checkout")}
                >
                  {busy === "checkout" ? "Opening..." : "Upgrade to Pro"}
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={busy !== null}
                onClick={() => void openBilling("portal")}
              >
                {busy === "portal" ? "Opening..." : "Customer Portal"}
              </Button>
            </div>
          ) : null}
        </>
      ) : message === null ? (
        <p className={styles.billingMessage} role="status">
          Loading Organization billing...
        </p>
      ) : null}
      {message ? (
        <div className={styles.billingActions}>
          <p className={styles.billingMessage} role="alert">
            {message}
          </p>
          <Button
            type="button"
            onClick={() => {
              setMessage(null);
              window.dispatchEvent(new Event("humans:credits-changed"));
            }}
          >
            Retry billing
          </Button>
        </div>
      ) : null}
    </section>
  );
}
