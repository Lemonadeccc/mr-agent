declare module "js-yaml" {
  export interface LoadYamlOptions {
    json?: boolean;
    schema?: unknown;
  }

  export function load(content: string, options?: LoadYamlOptions): unknown;
}
