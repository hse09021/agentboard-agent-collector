export type OsPlatform = "macos" | "windows" | "linux" | "unknown";

export function detectOS(): OsPlatform {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}
