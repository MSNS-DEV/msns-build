import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isNative } from "~/lib/mobile/native-service";

interface AppUrlOpenData {
  url: string;
}

interface AppListener {
  remove(): void;
}

// Ids taken from a deep link must be a single safe path segment, so a crafted
// link (e.g. msns://lms/reports/../../admin/...) cannot navigate elsewhere.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const extractId = (rawUrl: string, prefix: string): string | null => {
  const id = rawUrl.substring(prefix.length).split(/[?#]/)[0] ?? "";
  return SAFE_ID.test(id) ? id : null;
};

export const useDeepLinks = () => {
  const router = useRouter();

  useEffect(() => {
    if (!isNative()) return;

    let appListener: AppListener | undefined;
    void import("@capacitor/app").then(({ App }) => {
      void App.addListener("appUrlOpen", (data: AppUrlOpenData) => {
        try {
          const rawUrl = data.url;
          if (rawUrl.startsWith("msns://lms/reports/")) {
            const examId = extractId(rawUrl, "msns://lms/reports/");
            if (examId) {
              router.push(`/student/reports/${encodeURIComponent(examId)}`);
            }
          } else if (rawUrl.startsWith("msns://lms/approvals/")) {
            const poId = extractId(rawUrl, "msns://lms/approvals/");
            if (poId) {
              router.push(`/admin/erp/purchase-orders?poId=${encodeURIComponent(poId)}`);
            }
          }
        } catch (err) {
          console.error("[DeepLinks] Error parsing deep link URL:", err);
        }
      }).then((listener) => {
        appListener = listener;
      });
    });

    return () => {
      if (appListener) appListener.remove();
    };
  }, [router]);
};
