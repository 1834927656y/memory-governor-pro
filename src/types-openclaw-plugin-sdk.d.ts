declare module "openclaw/plugin-sdk" {
  export interface ToolDefinition {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: (...args: any[]) => Promise<unknown> | unknown;
  }

  export interface OpenClawPluginApi {
    registerTool(factory: (toolCtx?: unknown) => ToolDefinition, options?: { name?: string }): void;
  }
}
