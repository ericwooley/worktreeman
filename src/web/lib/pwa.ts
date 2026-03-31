export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

export interface MatchMediaLike {
  (query: string): {
    matches: boolean;
  };
}

export interface ServiceWorkerContainerLike {
  register: (scriptUrl: string, options?: RegistrationOptions) => Promise<unknown>;
}

export type PwaInstallStatus = "manual" | "available" | "installing" | "installed";

export function isPwaInstalled(options: {
  matchMedia?: MatchMediaLike | null;
  navigator?: unknown;
} = {}): boolean {
  const { matchMedia, navigator } = options;

  if (matchMedia?.("(display-mode: standalone)").matches) {
    return true;
  }

  return typeof navigator === "object"
    && navigator !== null
    && "standalone" in navigator
    && navigator.standalone === true;
}

export async function registerPwaServiceWorker(
  serviceWorker?: ServiceWorkerContainerLike | null,
  scriptUrl = "/sw.js",
): Promise<boolean> {
  if (!serviceWorker) {
    return false;
  }

  try {
    await serviceWorker.register(scriptUrl, { scope: "/" });
    return true;
  } catch {
    return false;
  }
}
