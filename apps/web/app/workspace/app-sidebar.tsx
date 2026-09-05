"use client";

import { UserButton } from "@clerk/nextjs";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@repo/ui/components/sidebar";
import { SearchIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const navigation = [
  {
    label: "Search Profiles",
    href: "/workspace?view=search",
    icon: SearchIcon,
  },
  { label: "My Profile", href: "/workspace?view=profile", icon: UserRoundIcon },
];

export function AppSidebar() {
  const view = useSearchParams().get("view") ?? "search";

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="px-2 pt-2 pb-3">
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Humans"
              className="group-data-[collapsible=icon]:justify-center"
              render={<Link href="/workspace?view=search" />}
            >
              <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold">
                H
              </span>
              <span className="font-semibold group-data-[collapsible=icon]:hidden">
                Humans
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navigation.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={view === item.href.split("=")[1]}
                    tooltip={item.label}
                    className="group-data-[collapsible=icon]:justify-center"
                    render={<Link href={item.href} />}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-2 pt-3 pb-2">
        <div className="flex h-10 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <UserButton />
          <span className="text-sm group-data-[collapsible=icon]:hidden">
            Account
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
