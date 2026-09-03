"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { Button } from "@repo/ui/components/button";
import { type ReactNode, useEffect, useRef, useState } from "react";

export function WorkspaceProvisioner({ children }: { children: ReactNode }) {
  const { isLoaded } = useAuth();
  const { setActive } = useOrganizationList();
  const { organization } = useOrganization();
  const [error, setError] = useState<string | null>(null);
  const [readyOrganizationId, setReadyOrganizationId] = useState<string | null>(
    null,
  );
  const readyOrganizationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !isLoaded ||
      setActive === undefined ||
      organization?.id === readyOrganizationIdRef.current
    ) {
      return;
    }

    const controller = new AbortController();
    setError(null);
    readyOrganizationIdRef.current = null;
    setReadyOrganizationId(null);
    void fetch("/api/workspace", { method: "POST", signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          organizationId?: string;
          error?: { code?: string; message?: string };
        };
        if (!response.ok || !result.organizationId) {
          throw new Error(
            result.error?.message ??
              "Workspace setup is temporarily unavailable",
          );
        }
        return result.organizationId;
      })
      .then(async (organizationId) => {
        if (organization?.id !== organizationId) {
          await setActive({ organization: organizationId });
        }
        readyOrganizationIdRef.current = organizationId;
        setReadyOrganizationId(organizationId);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Workspace setup failed",
          );
        }
      });

    return () => controller.abort();
  }, [isLoaded, organization?.id, setActive]);

  if (readyOrganizationId === organization?.id) {
    return <div key={readyOrganizationId}>{children}</div>;
  }

  return (
    <section className="workspaceReadiness" aria-live="polite">
      {error === null ? (
        <p>Preparing your Organization...</p>
      ) : (
        <>
          <p role="alert">{error}</p>
          <Button type="button" onClick={() => window.location.reload()}>
            Retry workspace setup
          </Button>
        </>
      )}
    </section>
  );
}
