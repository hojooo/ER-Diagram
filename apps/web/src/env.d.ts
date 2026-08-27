/// <reference types="vite/client" />

declare module "*.css";
declare module "*?url" {
  const assetUrl: string;
  export default assetUrl;
}
