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
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Humans"
              render={<Link href="/workspace?view=search" />}
            >
              <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg font-semibold">
                H
              </span>
              <span className="font-semibold">Humans</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={view === item.href.split("=")[1]}
                    tooltip={item.label}
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
      <SidebarFooter>
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
