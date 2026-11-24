// Ambient Node/uTools globals for preload JSDoc type generation only (not bundled)
declare function require(id: string): any;
declare const module: { exports: any };
declare const exports: any;
declare const process: { pid: number; execPath: string; argv: string[]; env: Record<string, string | undefined>; allowedNodeEnvironmentFlags?: Set<string> };
declare var Buffer: any;
declare const __dirname: string;
declare const __filename: string;
declare const global: any;

interface Window {
  utools: any;
  airss: any;
}

declare module "fs" {
  const fs: any;
  export = fs;
}
declare module "path" {
  const path: any;
  export = path;
}
declare module "zlib" {
  const zlib: any;
  export = zlib;
}
declare module "crypto" {
  const crypto: any;
  export = crypto;
}
declare module "os" {
  const os: any;
  export = os;
}
declare module "http" {
  const http: any;
  export = http;
}
declare module "https" {
  const https: any;
  export = https;
}
declare module "buffer" {
  export const Buffer: any;
}
declare module "minisearch" {
  class MiniSearch<T = any> {
    constructor(options?: any);
    documentCount: number;
    add(doc: T): void;
    addAll(docs: T[]): void;
    remove(doc: T): void;
    discard(id: any): void;
    has(id: any): boolean;
    replace(doc: T): void;
    search(query: string, options?: any): any[];
    toJSON(): any;
    static loadJSON(json: string, options?: any): MiniSearch<any>;
  }
  export = MiniSearch;
}
