import type { NuGetContainer } from "./index";
export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  INSPECTOR: DurableObjectNamespace<NuGetContainer>;
  PUBLIC_URL: string;
  READ_API_KEY: string;
  PUSH_API_KEY: string;
  INTERNAL_API_KEY: string;
}
export interface Dependency { id: string; range: string }
export interface DependencyGroup { targetFramework: string; dependencies: Dependency[] }
export interface PackageMetadata {
  id: string; version: string; description: string; authors: string[]; tags: string[];
  title?: string; projectUrl?: string; licenseExpression?: string; requireLicenseAcceptance: boolean;
  prerelease: boolean; semVer2: boolean; sha512: string; nuspec: string; dependencyGroups: DependencyGroup[];
}
export interface PackageRow {
  id: string; version: string; object_key: string; metadata: string; listed: number;
  prerelease: number; semver2: number; published: string;
}
