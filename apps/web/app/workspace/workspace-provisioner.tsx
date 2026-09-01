"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { useEffect, useState } from "react";

export function WorkspaceProvisioner() {
  const { isLoaded } = useAuth();
  const { setActive } = useOrganizationList();
  const { organization } = useOrganization();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;

    const controller = new AbortController();
    void fetch("/api/workspace", { method: "POST", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Workspace setup failed");
        return (await response.json()) as { organizationId: string };
      })
      .then(async (workspace) => {
        if (setActive !== undefined && organization?.id !== workspace.organizationId) {
          await setActive({ organization: workspace.organizationId });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Workspace setup failed");
        }
      });

    return () => controller.abort();
  }, [isLoaded, organization?.id, setActive]);

  return error === null ? null : <p role="alert">{error}</p>;
}
