/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Every route reads the live control plane; nothing here is prerendered.
  experimental: {},
};

export default nextConfig;