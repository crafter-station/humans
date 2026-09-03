import type * as React from "react";

import { cn } from "@repo/ui/lib/utils";

function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "border-input accent-primary focus-visible:ring-ring/50 size-4 shrink-0 rounded border shadow-xs outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Checkbox };
