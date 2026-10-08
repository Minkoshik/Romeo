import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  headers() {
    const headers = [{key:"Referrer-Policy",value:"no-referrer"},{key:"X-Robots-Tag",value:"noindex, nofollow"}];
    const privateHeaders = [...headers,{key:"Cache-Control",value:"no-store"}];
    return [{source:"/appointment/:path*",headers},{source:"/api/appointments/:path*",headers},
      {source:"/admin/:path*",headers:privateHeaders},{source:"/api/admin/:path*",headers:privateHeaders}];
  }
};
export default nextConfig;
