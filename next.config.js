// Only the school's own R2 account may be optimised by next/image; a
// wildcard here would let anyone proxy any public R2 bucket through us.
const DEFAULT_R2_ENDPOINT =
  "https://c678cf5c0fc5ef3806edacc18e6a762d.r2.cloudflarestorage.com";
const r2Hostname = (() => {
  try {
    return new URL(
      process.env.S3_ENDPOINT ??
        process.env.AWS_ENDPOINT_URL ??
        DEFAULT_R2_ENDPOINT,
    ).hostname;
  } catch {
    return new URL(DEFAULT_R2_ENDPOINT).hostname;
  }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 31536000,
    remotePatterns: [
      {
        protocol: "https",
        hostname: r2Hostname,
      },
      {
        protocol: "https",
        hostname: "msns.edu.pk",
      },
      {
        protocol: "https",
        hostname: "lms.msns.edu.pk",
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: "/uploads/:path*",
        destination: "/api/uploads/:path*",
      },
    ];
  },
};

export default nextConfig;
