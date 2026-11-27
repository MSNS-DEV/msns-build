"use client";

import { toast as sonner } from "sonner";

/**
 * The app-wide toaster is sonner (mounted in src/app/provider.tsx). This keeps
 * the shadcn-style call shape used across these components.
 */
export function toast({
  title,
  description,
  variant,
}: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}) {
  if (variant === "destructive") sonner.error(title, { description });
  else sonner.success(title, { description });
}
