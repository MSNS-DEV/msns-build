"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import SecuritySettings from "~/components/blocks/security/SecuritySettings";

export default function ParentSecurityPage() {
  return (
    // The parent portal is always dark; scope the shared components to dark tokens.
    <div className="dark space-y-4 text-foreground">
      <Link
        href="/parent/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-emerald-400 hover:text-emerald-300"
      >
        <ArrowLeft className="h-4 w-4" /> Back to dashboard
      </Link>
      <SecuritySettings />
    </div>
  );
}
