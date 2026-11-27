import { type Metadata } from "next";
import VerifyClient from "./verify-client";

export const metadata: Metadata = {
  title: "Two-factor verification | MSNS LMS",
  robots: { index: false, follow: false },
};

export default function VerifyPage() {
  return <VerifyClient />;
}
