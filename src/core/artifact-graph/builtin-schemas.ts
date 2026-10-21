/**
 * Where the built-in schemas live when the package's `schemas/` directory is
 * not next to dist/ or cannot be listed — a standalone executable that embeds
 * it, for example. The npm package never registers one, so the resolver keeps
 * finding `<package>/schemas` from its own location and listing it.
 *
 * Kept free of imports so a standalone entry can register the schemas without
 * loading the resolver, and everything it pulls in, at startup.
 */
export interface BuiltinSchemas {
  /** Directory holding `<name>/schema.yaml` and `<name>/templates/` per schema. */
  dir: string;
  /** Built-in schema names, recorded at build time, used instead of listing `dir`. */
  names: readonly string[];
}

let registered: BuiltinSchemas | undefined;

export function registerBuiltinSchemas(schemas: BuiltinSchemas | undefined): void {
  registered = schemas;
}

export function getRegisteredBuiltinSchemas(): BuiltinSchemas | undefined {
  return registered;
}
