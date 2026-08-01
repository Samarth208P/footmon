/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Resolve missing optional peer dependencies from @coinbase/cdp-sdk
    // which is transitively pulled in by @reown/appkit-adapter-ethers
    config.resolve.fallback = {
      ...config.resolve.fallback,
    };
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : []),
    ];
    // Ignore optional modules that aren't installed
    config.plugins.push(
      new (require("webpack")).IgnorePlugin({
        resourceRegExp: /^@x402\//,
      })
    );
    return config;
  },
};

module.exports = nextConfig;
