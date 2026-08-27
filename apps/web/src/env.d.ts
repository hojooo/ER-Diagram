/// <reference types="vite/client" />

declare module "*.css";
declare module "*?url" {
  const assetUrl: string;
  export default assetUrl;
}

declare module "monaco-editor/editor/contrib/find/browser/findController";
declare module "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
