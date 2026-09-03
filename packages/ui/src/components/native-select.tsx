import type * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@repo/ui/lib/utils";

function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className="relative" data-slot="native-select-wrapper">
      <select
        data-slot="native-select"
        className={cn(
          "border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 h-8 w-full appearance-none rounded-lg border px-2.5 pr-8 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2" />
    </div>
  );
}

export { NativeSelect };
