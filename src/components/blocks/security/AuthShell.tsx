"use client";

import Image from "next/image";

/** Centered card on the campus background, shared by the sign-in follow-up pages. */
export function AuthShell({
  title,
  subtitle,
  children,
  wide,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-slate-950 px-4 py-10">
      <div className="absolute inset-0 z-0">
        <Image
          src="/api/images/resolve/FrontView1_alaabu.jpg"
          alt=""
          fill
          priority
          className="object-cover opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-emerald-950/60" />
      </div>
      <div
        className={`relative z-10 w-full ${wide ? "max-w-4xl" : "max-w-md"} rounded-3xl border border-white/10 bg-background/95 p-6 shadow-2xl backdrop-blur-xl sm:p-8`}
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="relative mb-3 h-16 w-16">
            <Image
              src="/api/images/logos/Official_LOGO_grn_ic9ldd.png"
              alt="M. S. Naz High School"
              fill
              sizes="64px"
              className="object-contain"
            />
          </div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}
