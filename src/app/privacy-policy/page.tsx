import React from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LMS Privacy Policy & Student Data Protection",
  description:
    "Privacy Policy and security protocols governing student academic records, parent communications, and authentication data on the MSNS Learning Management System.",
  alternates: {
    canonical: "https://lms.msns.edu.pk/privacy-policy",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto min-h-screen max-w-4xl bg-[#020806] px-6 py-12 text-slate-100 md:px-24">
      <h1 className="mb-6 text-3xl font-bold text-emerald-400 md:text-4xl">
        Privacy Policy
      </h1>
      <p className="mb-8 text-sm text-slate-400">
        Last updated: August 6, 2026
      </p>

      <div className="space-y-6 text-base leading-relaxed text-slate-300">
        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">1. Overview</h2>
          <p>
            M.S. Naz High School (&quot;MSNS LMS&quot;, &quot;we&quot;,
            &quot;us&quot;, or &quot;our&quot;) operates the MSNS Learning
            Management System mobile application and web portal. This page
            informs users of our policies regarding the collection, use, and
            disclosure of Personal Information.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">
            2. Information Collection and Use
          </h2>
          <p>
            For a better experience while using our Service, we may require you
            to provide us with certain personally identifiable information,
            including but not limited to student name, roll number, email
            address, attendance records, grades, and academic assignments.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">
            3. Data Security
          </h2>
          <p>
            We value your trust in providing us your Personal Information, thus
            we are striving to use commercially acceptable means of protecting
            it. All data transmitted between the app and our servers is
            encrypted over HTTPS (SSL).
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">
            4. Third-Party Services
          </h2>
          <p>
            The application may utilize secure cloud infrastructure (such as
            Google Cloud Storage and Database hosting) solely for storing school
            documents, photos, and PDF grade sheets.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">
            5. User Account & Data Deletion
          </h2>
          <p>
            Students and guardians can request account deletion or data
            modification by contacting the school administration office directly
            or emailing us at support@msns-lms.com.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xl font-semibold text-white">
            6. Contact Us
          </h2>
          <p>
            If you have any questions or suggestions about our Privacy Policy,
            do not hesitate to contact M.S. Naz High School administration.
          </p>
        </section>
      </div>
    </div>
  );
}
