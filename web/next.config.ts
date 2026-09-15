import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";

loadEnv({ path: resolve(__dirname, "../.env") });

const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
