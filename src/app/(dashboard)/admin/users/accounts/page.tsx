"use client";

import { PageHeader } from "~/components/blocks/nav/PageHeader";
import AccountsAdmin from "~/components/blocks/security/AccountsAdmin";

export default function AccountsAccessPage() {
  return (
    <div className="w-full space-y-4">
      <PageHeader
        breadcrumbs={[
          { href: "/admin", label: "Dashboard" },
          { href: "/admin/users", label: "User Management" },
          {
            href: "/admin/users/accounts",
            label: "Accounts & Access",
            current: true,
          },
        ]}
      />
      <div className="px-4 pb-8 sm:px-6">
        <AccountsAdmin />
      </div>
    </div>
  );
}
