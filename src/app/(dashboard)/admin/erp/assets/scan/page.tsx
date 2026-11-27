"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { QrCode, Search, Package, ShieldCheck } from "lucide-react";
import { Button } from "~/components/ui/button";

interface AssetRegisterItem {
  assetId: string;
  assetTag: string;
  assetName: string;
  location?: string | null;
  purchaseCost?: number | null;
  AssetCategory?: {
    name?: string;
  } | null;
}

export default function AssetBarcodeScanPage() {
  const [scannedTag, setScannedTag] = useState<string | null>(null);

  const { data: assets } = api.erp.assets.getAssetRegister.useQuery({});

  const handleScan = async () => {
    const { scanBarcode } = await import("~/lib/mobile/native-service");
    const barcode = await scanBarcode();
    if (barcode) {
      setScannedTag(barcode);
    }
  };

  const matchedAsset = (
    assets?.assets as AssetRegisterItem[] | undefined
  )?.find((a) => a.assetTag === scannedTag || a.assetId === scannedTag);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <QrCode className="h-6 w-6 text-emerald-400" /> Barcode & Asset Tag
          Scanner
        </h1>
        <p className="text-sm text-slate-400">
          Scan physical asset tags using ML Kit scanner to view inventory
          details
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center backdrop-blur-md">
        <div className="flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
            <QrCode className="h-10 w-10 animate-pulse" />
          </div>
        </div>

        <p className="text-sm text-slate-300">
          Click below to initiate full-screen ML Kit camera barcode scanner.
        </p>

        <Button
          onClick={handleScan}
          className="w-full bg-emerald-600 py-4 text-base font-bold text-slate-950 shadow-lg shadow-emerald-600/20 hover:bg-emerald-500"
        >
          <Search className="mr-2 h-5 w-5" /> Scan Barcode Tag
        </Button>
      </div>

      {scannedTag && (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-semibold uppercase text-slate-400">
              Scanned Code
            </span>
            <span className="font-mono text-sm font-bold text-emerald-400">
              {scannedTag}
            </span>
          </div>

          {!matchedAsset ? (
            <p className="text-sm italic text-slate-400">
              No asset record found matching tag &quot;{scannedTag}&quot;.
            </p>
          ) : (
            <div className="space-y-2 text-sm text-slate-200">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-emerald-400" />
                <span className="font-bold text-white">
                  {matchedAsset.assetName}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Category: {matchedAsset.AssetCategory?.name ?? "General Asset"}
              </p>
              <p className="text-xs text-slate-400">
                Location: {matchedAsset.location ?? "Main Facility"}
              </p>
              <div className="flex items-center justify-between border-t border-slate-800 pt-2 text-xs">
                <span>
                  Purchase Cost: PKR{" "}
                  {(matchedAsset.purchaseCost ?? 0).toLocaleString()}
                </span>
                <span className="flex items-center gap-1 font-bold text-emerald-400">
                  <ShieldCheck className="h-3.5 w-3.5" /> Verified
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
