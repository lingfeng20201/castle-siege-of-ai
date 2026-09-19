/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 原生依赖保持 Node.js 运行时（不打包进 bundle）
  experimental: {
    serverComponentsExternalPackages: ['argon2', 'ioredis', 'pg', 'nodemailer'],
  },
};

export default nextConfig;
