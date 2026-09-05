import { OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Separator } from "@repo/ui/components/separator";
import { ModeToggle } from "@repo/ui/components/mode-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/ui/components/sidebar";
import { cookies } from "next/headers";

import { AppSidebar } from "./app-sidebar";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await auth.protect();
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-[clamp(1rem,4vw,4rem)]">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="h-4" />
            <span className="truncate text-sm font-medium">
              Protected directory
            </span>
          </div>
          <div className="flex min-w-0 max-w-[min(60%,22rem)] shrink items-center justify-end gap-2">
            <div className="shrink-0">
              <ModeToggle />
            </div>
            <OrganizationSwitcher
              hidePersonal
              appearance={{
                elements: {
                  rootBox: "min-w-0 max-w-full overflow-hidden",
                  organizationSwitcherTrigger:
                    "min-w-0 max-w-full overflow-hidden",
                  organizationPreview: "min-w-0",
                  organizationPreviewTextContainer: "min-w-0",
                  organizationPreviewMainIdentifier: "truncate",
                },
              }}
            />
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
